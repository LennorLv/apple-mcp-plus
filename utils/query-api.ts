import { z } from "zod";
import reminders, { reminderSchema, queryRemindersPage } from "./reminders";
import { eventSchema, queryEventsPage } from "./calendar";
import { queryOptionsSchema } from "./jxa-query";
import { eventkit, NativeError } from "./eventkit";

const metaSchema = z.object({backend:z.literal("eventkit"),totalMatched:z.number().int().nonnegative(),returned:z.number().int().nonnegative(),
  complete:z.boolean(),truncated:z.boolean(),ordering:z.string()});
const containerSchema = z.object({id:z.string(),idType:z.literal("eventkit-calendar"),name:z.string(),sourceId:z.string(),sourceName:z.string(),writable:z.boolean()});
const nativeReminderSchema = reminderSchema.extend({idType:z.literal("eventkit-reminder"),externalId:z.string().nullable(),listId:z.string(),dueDateIsDateOnly:z.boolean(),alarmDate:z.string().nullable()});
const nativeEventSchema = eventSchema.extend({idType:z.literal("eventkit-event"),externalId:z.string().nullable(),calendarId:z.string(),calendarItemId:z.string(),
  isRecurring:z.boolean(),isDetached:z.boolean(),occurrenceDate:z.string().nullable(),timeZone:z.string().nullable()});
export const readArgsSchema = z.object({
  operation:z.enum(["list","search","listById","lists","calendars","getById","authorize"]),
  backend:z.enum(["jxa","eventkit"]).optional(),limit:z.number().int().min(1).max(100).optional(),
  searchText:z.string().refine(s=>s.trim().length>0,"Nonempty text required").optional(),completed:z.boolean().optional(),
  listName:z.string().refine(s=>s.trim().length>0,"Nonempty text required").optional(),listId:z.string().refine(s=>s.trim().length>0,"Nonempty text required").optional(),
  props:z.array(z.string()).optional(),calendarName:z.string().refine(s=>s.trim().length>0,"Nonempty text required").optional(),
  calendarId:z.string().refine(s=>s.trim().length>0,"Nonempty text required").optional(),calendarIds:z.array(z.string().refine(s=>s.trim().length>0,"Nonempty text required")).min(1).optional(),
  fromDate:z.string().datetime({offset:true}).optional(),toDate:z.string().datetime({offset:true}).optional(),
  eventId:z.string().refine(s=>s.trim().length>0,"Nonempty text required").optional(),occurrenceDate:z.string().datetime({offset:true}).optional(),
}).strict().superRefine((p,ctx)=>{
  if(!queryOptionsSchema.safeParse(p).success) ctx.addIssue({code:"custom",message:"Invalid date range"});
  if(p.operation==="search" && !p.searchText) ctx.addIssue({code:"custom",message:"searchText is required"});
  if(p.operation==="listById" && !p.listId) ctx.addIssue({code:"custom",message:"listId is required"});
  if(p.operation==="getById" && !p.eventId) ctx.addIssue({code:"custom",message:"eventId is required"});
  if(p.calendarId && p.calendarIds) ctx.addIssue({code:"custom",message:"Use calendarId or calendarIds, not both"});
});
const nativeOnly = new Set(["lists","calendars","getById","authorize"]);
export async function readQuery(tool:"reminders"|"calendar", input:unknown) {
  const parsed=readArgsSchema.safeParse(input);
  if(!parsed.success) throw new NativeError("invalid_arguments",parsed.error.issues.map(x=>x.message).join("; "),"validation");
  const p=parsed.data;
  if(p.props && p.operation!=="listById") throw new NativeError("invalid_arguments","props is only supported by listById","validation");
  const incompatible = tool==="reminders" ? ["calendarName","calendarId","calendarIds","eventId","occurrenceDate","fromDate","toDate"]
    : ["listName","listId","props","completed"];
  if(incompatible.some(key=>(p as Record<string,unknown>)[key]!==undefined))
    throw new NativeError("invalid_arguments","One or more filters are not supported by this tool","validation");
  const supported=tool==="reminders" ? ["list","search","listById","lists","authorize"] : ["list","search","calendars","getById","authorize"];
  if(!supported.includes(p.operation)) throw new NativeError("unsupported","Operation is not supported for this tool","validation");
  const backend=p.backend ?? (nativeOnly.has(p.operation)?"eventkit":"jxa");
  if(tool==="reminders" && p.props?.some(k=>!Object.hasOwn(reminderSchema.shape,k))) throw new NativeError("invalid_arguments","Unsupported reminder property","validation");
  if(backend==="jxa" && (nativeOnly.has(p.operation) || p.calendarId || p.calendarIds)) throw new NativeError("unsupported","This operation or ID filter requires backend eventkit","jxa");
  let result:Record<string,unknown>;
  if(backend==="eventkit") {
    const op=p.operation==="authorize"?"authorize": ["lists","calendars"].includes(p.operation)?"containers":p.operation==="getById"?"getById":"query";
    const from=p.fromDate ?? new Date().toISOString();
    const to=p.toDate ?? new Date(Date.parse(from)+(p.operation==="search"?30:7)*86400000).toISOString();
    if(tool==="calendar" && op==="query" && !(Date.parse(from)<Date.parse(to) && Date.parse(to)-Date.parse(from)<=366*86400000))
      throw new NativeError("invalid_arguments","Date range must be increasing and at most 366 days","validation");
    const raw=await eventkit.call(`${tool}.${op}`,{...p,...(tool==="calendar" && op==="query"?{fromDate:from,toDate:to}:{})});
    const schema = op==="authorize"?z.object({authorization:z.literal("full_access")}):op==="containers"?z.object({containers:z.array(containerSchema)}):op==="getById"?
      z.object({event:nativeEventSchema}):tool==="reminders"?z.object({reminders:z.array(nativeReminderSchema),lists:z.array(containerSchema),meta:metaSchema}):
      z.object({events:z.array(nativeEventSchema),meta:metaSchema});
    const validated=schema.safeParse(raw);
    if(!validated.success) throw new NativeError("data_unavailable","EventKit returned an unexpected data structure");
    result=validated.data;
    if(op==="containers") result={[tool==="reminders"?"lists":"calendars"]:raw.containers,meta:{backend,complete:true,truncated:false}};
    if(op==="getById" || op==="authorize") result={...result,meta:{backend,complete:true,truncated:false}};
  } else if(tool==="reminders") {
    const page=await queryRemindersPage(p,p.operation==="search"?p.searchText:undefined,p.listId);
    result={reminders:page.reminders.map(r=>({...r,idType:"jxa-reminder"})),
      ...(p.operation==="list"?{lists:await reminders.getAllLists()}:{}),
      meta:{backend,complete:!page.truncated,truncated:page.truncated,returned:page.reminders.length,totalMatched:page.truncated?null:page.reminders.length,
        ordering:"Reminders application order"}};
  } else {
    const page=await queryEventsPage(p.limit,p.fromDate,p.toDate,p.operation==="search"?p.searchText:undefined,p.calendarName);
    result={events:page.events.map(e=>({...e,idType:"jxa-calendar-uid"})),meta:{backend,complete:!page.truncated,truncated:page.truncated,
      returned:page.events.length,totalMatched:page.totalMatched,ordering:"startDate then Calendar UID ascending"}};
  }
  if(p.operation==="listById" && p.props) result.reminders=(result.reminders as Record<string,unknown>[]).map(r=>Object.fromEntries(p.props!.map(k=>[k,r[k]])));
  return {content:[{type:"text" as const,text:JSON.stringify(result)}],structuredContent:result,
    ...(tool==="reminders"?{reminders:result.reminders,lists:result.lists}:{}),isError:false};
}
