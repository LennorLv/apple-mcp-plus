import {z} from "zod";
import {runQuery,validateQueryOptions} from "./jxa-query";

export const eventSchema=z.object({id:z.string(),title:z.string(),location:z.string().nullable(),
  notes:z.string().nullable(),startDate:z.string(),endDate:z.string(),calendarName:z.string(),
  isAllDay:z.boolean(),url:z.string().nullable()});
const eventHelpers=`
  var app=Application('Calendar');
  function readEvent(e,c){
    var end=e.endDate();var allDay=e.alldayEvent();
    // Calendar represents all-day end as 23:59:59; the MCP uses an exclusive end.
    if(allDay && end.getHours()===23 && end.getMinutes()===59 && end.getSeconds()===59)
      end=new Date(end.getTime()+1000);
    return {id:e.uid(),title:e.summary(),location:e.location() || null,
    notes:e.description() || null,startDate:e.startDate().toISOString(),endDate:end.toISOString(),
    calendarName:c.name(),isAllDay:allDay,url:e.url() || null};}
`;
async function queryEvents(limit=10,fromDate?:string,toDate?:string,searchText?:string) {
  return (await queryEventsPage(limit,fromDate,toDate,searchText)).events;
}
export async function queryEventsPage(limit=10,fromDate?:string,toDate?:string,searchText?:string,calendarName?:string) {
  validateQueryOptions({limit,fromDate,toDate});
  const from=fromDate || new Date().toISOString();
  const to=toDate || new Date(Date.parse(from)+(searchText?30:7)*86400000).toISOString();
  validateQueryOptions({limit,fromDate:from,toDate:to});
  return runQuery(`${eventHelpers}
    var result=[];var term=(p.searchText || '').toLowerCase();
    var calendars=app.calendars();
    if(p.calendarName){calendars=calendars.filter(function(c){return c.name()===p.calendarName;});
      if(!calendars.length) throw new Error('Calendar not found');
      if(calendars.length>1) throw new Error('Calendar name is ambiguous');}
    calendars.forEach(function(c){
      var filters=[{startDate:{_lessThan:new Date(p.to)}},
        {endDate:{_greaterThan:new Date(Date.parse(p.from)-1000)}}];
      if(p.searchText && p.searchText.indexOf("\\n")<0) filters.push({_or:[{summary:{_contains:p.searchText}},
        {location:{_contains:p.searchText}},{description:{_contains:p.searchText}}]});
      // Resolve the range/search predicate once, then fetch each object's properties once.
      // Apple Events text comparisons are case-insensitive; keep the local verification below.
      var events=c.events.whose({_and:filters})();var calendarName=c.name();
      events.forEach(function(e){var d=e.properties(),end=d.endDate,allDay=d.alldayEvent;
        if(allDay && end.getHours()===23 && end.getMinutes()===59 && end.getSeconds()===59) end=new Date(end.getTime()+1000);
        var data={id:d.uid,title:d.summary,location:d.location || null,notes:d.description || null,
          startDate:d.startDate.toISOString(),endDate:end.toISOString(),calendarName:calendarName,
          isAllDay:allDay,url:d.url || null};
        if(Date.parse(data.endDate)<=Date.parse(p.from)) return;
        if(term && [data.title,data.location || '',data.notes || ''].join('\\n').toLowerCase().indexOf(term)<0) return;
        result.push(data);
      });
    });
    result.sort(function(a,b){return Date.parse(a.startDate)-Date.parse(b.startDate) || a.id.localeCompare(b.id);});
    return {events:result.slice(0,p.limit),totalMatched:result.length,truncated:result.length>p.limit};`,{limit,from,to,searchText,calendarName},
      z.object({events:z.array(eventSchema),totalMatched:z.number().int(),truncated:z.boolean()}),45000);
}
async function getEvents(limit=10,fromDate?:string,toDate?:string) {
  return queryEvents(limit,fromDate,toDate);
}
async function searchEvents(searchText:string,limit=10,fromDate?:string,toDate?:string) {
  if(typeof searchText!=="string" || !searchText.trim()) throw new Error("Search text is required");
  return queryEvents(limit,fromDate,toDate,searchText);
}
async function createEvent(title:string,startDate:string,endDate:string,location?:string,
  notes?:string,isAllDay=false,calendarName?:string) {
  const p=z.object({title:z.string().trim().min(1),startDate:z.string().datetime({offset:true}),
    endDate:z.string().datetime({offset:true}),location:z.string().optional(),notes:z.string().optional(),
    isAllDay:z.boolean(),calendarName:z.string().trim().min(1).optional()})
    .refine(p=>Date.parse(p.startDate)<Date.parse(p.endDate),"End date must be after start date")
    .parse({title,startDate,endDate,location,notes,isAllDay,calendarName});
  const event=await runQuery(`${eventHelpers}
    var cs=app.calendars().filter(function(c){return p.calendarName?c.name()===p.calendarName:c.writable();});
    if(!cs.length) throw new Error('Writable target calendar not found');
    if(p.calendarName && cs.length!==1) throw new Error('Target calendar name is ambiguous');
    var c=cs[0];if(!c.writable()) throw new Error('Target calendar is read-only');
    var e=app.Event({summary:p.title,startDate:new Date(p.startDate),endDate:new Date(p.endDate),
      location:p.location || '',description:p.notes || '',alldayEvent:p.isAllDay});
    c.events.push(e);return readEvent(e,c);`,p,eventSchema,45000);
  return {success:true,message:"Calendar event created and read back.",eventId:event.id,event};
}
async function openEvent(eventId:string) {
  if(!eventId?.trim()) throw new Error("Event ID is required");
  return runQuery(`${eventHelpers}
    var cs=app.calendars();
    for(var i=0;i<cs.length;i++){
      var es=cs[i].events.whose({uid:p.eventId})();
      if(es.length){app.activate();
        // In month view, show can leave the previous event selected. Navigate first.
        app.switchView({to:'day view'});app.viewCalendar({at:es[0].startDate()});es[0].show();
        return {success:true,message:'Opened the requested calendar event',eventId:es[0].uid()};}
    } throw new Error('Calendar event not found');`,{eventId},
    z.object({success:z.boolean(),message:z.string(),eventId:z.string()}),45000);
}
async function requestCalendarAccess() {
  try{await runQuery("return Application('Calendar').name();",{},z.string());
    return {hasAccess:true,message:"Calendar automation access is granted."};}
  catch(e){return {hasAccess:false,message:String(e)};}
}
export default {getEvents,searchEvents,createEvent,openEvent,requestCalendarAccess};
