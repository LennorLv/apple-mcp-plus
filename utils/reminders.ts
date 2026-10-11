import { runAppleScript } from "run-applescript";
import { z } from "zod";
import { runQuery, validateQueryOptions } from "./jxa-query";

// Configuration
const CONFIG = {
	// Maximum reminders to process (to avoid performance issues)
	MAX_REMINDERS: 50,
	// Maximum lists to process
	MAX_LISTS: 20,
	// Timeout for operations
	TIMEOUT_MS: 8000,
};

// Define types for our reminders
interface ReminderList {
	name: string;
	id: string;
}

interface Reminder {
	name: string;
	id: string;
	body: string;
	completed: boolean;
	dueDate: string | null;
	listName: string;
	completionDate?: string | null;
	creationDate?: string | null;
	modificationDate?: string | null;
	remindMeDate?: string | null;
	priority?: number;
}

/**
 * Check if Reminders app is accessible
 */
async function checkRemindersAccess(): Promise<boolean> {
	try {
		const script = `
tell application "Reminders"
    return name
end tell`;

		await runAppleScript(script);
		return true;
	} catch (error) {
		console.error(
			`Cannot access Reminders app: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * Request Reminders app access and provide instructions if not available
 */
async function requestRemindersAccess(): Promise<{ hasAccess: boolean; message: string }> {
	try {
		// First check if we already have access
		const hasAccess = await checkRemindersAccess();
		if (hasAccess) {
			return {
				hasAccess: true,
				message: "Reminders access is already granted."
			};
		}

		// If no access, provide clear instructions
		return {
			hasAccess: false,
			message: "Reminders access is required but not granted. Please:\n1. Open System Settings > Privacy & Security > Automation\n2. Find your terminal/app in the list and enable 'Reminders'\n3. Restart your terminal and try again\n4. If the option is not available, run this command again to trigger the permission dialog"
		};
	} catch (error) {
		return {
			hasAccess: false,
			message: `Error checking Reminders access: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

/**
 * Get all reminder lists (limited for performance)
 * @returns Array of reminder lists with their names and IDs
 */
export const reminderSchema=z.object({id:z.string(),name:z.string(),body:z.string(),
  completed:z.boolean(),dueDate:z.string().nullable(),listName:z.string(),
  creationDate:z.string().nullable(),modificationDate:z.string().nullable(),
  completionDate:z.string().nullable(),remindMeDate:z.string().nullable(),priority:z.number()});
export interface ReminderQueryOptions { limit?:number; completed?:boolean; listName?:string; listId?:string; }
const reminderOptionsSchema=z.object({limit:z.number().int().min(1).max(100).optional(),
  completed:z.boolean().optional(),listName:z.string().min(1).optional(),listId:z.string().min(1).optional()});
async function getAllLists(): Promise<ReminderList[]> {
  return runQuery("var app=Application('Reminders'); if(!app.running()){app.launch();delay(1);} return app.lists().map(function(l) {return {id:l.id(),name:l.name()};});",
    {},z.array(z.object({id:z.string(),name:z.string()})));
}
async function queryReminders(options: ReminderQueryOptions = {}, searchText?:string, listId?:string) {
  return (await queryRemindersPage(options,searchText,listId)).reminders;
}
export async function queryRemindersPage(options: ReminderQueryOptions = {}, searchText?:string, listId?:string) {
  const parameters=reminderOptionsSchema.parse(options);
  validateQueryOptions(parameters);
  return runQuery(`
    var app=Application('Reminders'); if(!app.running()){app.launch();delay(1);} var lists=app.lists();
    if(p.listName) lists=lists.filter(function(l){return l.name()===p.listName;});
    if(p.listId) lists=lists.filter(function(l){return l.id()===p.listId;});
    if((p.listId || p.listName) && !lists.length) throw new Error('Reminder list not found');
    if(p.listName && lists.length>1) throw new Error('Reminder list name is ambiguous; select an exact list ID');
    function iso(d){return d ? d.toISOString() : null;}
    var term=(p.searchText || '').toLowerCase(); var result=[];var hasMore=false;
    lists.forEach(function(l){
      if(hasMore) return;
      var completion=l.reminders.completed(); var items=l.reminders;
      var names=term ? l.reminders.name() : []; var bodies=term ? l.reminders.body() : [];
      var selected=[];
      for(var i=0;i<completion.length && selected.length+result.length<p.scanLimit;i++){
        var completed=completion[i];
        if(term && names[i].toLowerCase().indexOf(term)<0 && (bodies[i] || '').toLowerCase().indexOf(term)<0) continue;
        if(p.completed!==undefined && completed!==p.completed) continue;
        selected.push(i);
      }
      if(selected.length+result.length>p.limit){hasMore=true;selected.pop();}
      if(!selected.length) return;
      var listName=l.name();
      // One properties request per selected object avoids slow range/column descriptors.
      // Read at most limit objects; the truncation sentinel never requests full properties.
      selected.forEach(function(i){var d=items[i].properties();result.push({id:d.id,
        name:d.name,body:d.body || '',completed:d.completed,listName:listName,dueDate:iso(d.dueDate),
        creationDate:iso(d.creationDate),modificationDate:iso(d.modificationDate),
        completionDate:iso(d.completionDate),remindMeDate:iso(d.remindMeDate),priority:d.priority});});
    }); return {reminders:result,truncated:hasMore};
  `,{...parameters,limit:parameters.limit || 50,scanLimit:(parameters.limit || 50)+1,searchText,listId:listId || parameters.listId},
    z.object({reminders:z.array(reminderSchema),truncated:z.boolean()}),45000);
}
async function getAllReminders(listName?:string, options:ReminderQueryOptions={}) {
  return queryReminders({...options,listName:listName || options.listName});
}
async function searchReminders(searchText:string, options:ReminderQueryOptions={}) {
  if(!searchText.trim()) throw new Error('Search text is required');
  return queryReminders(options,searchText);
}

/**
 * Create a new reminder (simplified for performance)
 * @param name Name of the reminder
 * @param listName Name of the list to add the reminder to (creates if doesn't exist)
 * @param notes Optional notes for the reminder
 * @param dueDate Optional due date for the reminder (ISO string)
 * @returns The created reminder
 */
async function createReminder(name:string,listName?:string,notes?:string,dueDate?:string):Promise<Reminder> {
  const parameters=z.object({name:z.string().trim().min(1),listName:z.string().trim().min(1).optional(),
    notes:z.string().optional(),dueDate:z.string().datetime({offset:true}).optional()})
    .parse({name,listName,notes,dueDate});
  return runQuery(`
    var app=Application('Reminders');var lists=app.lists();
    var matches=p.listName?lists.filter(function(l){return l.name()===p.listName;}):[app.defaultList()];
    if(!matches.length) throw new Error('Reminder list not found');
    if(matches.length!==1) throw new Error('Reminder list name is ambiguous');
    var target=matches[0];var properties={name:p.name,body:p.notes || '',completed:false};
    if(p.dueDate) properties.dueDate=new Date(p.dueDate);
    var r=app.Reminder(properties);target.reminders.push(r);var data=r.properties();
    function iso(d){return d?d.toISOString():null;}
    return {id:data.id,name:data.name,body:data.body || '',completed:data.completed,
      listName:target.name(),dueDate:iso(data.dueDate),creationDate:iso(data.creationDate),
      modificationDate:iso(data.modificationDate),completionDate:iso(data.completionDate),
      remindMeDate:iso(data.remindMeDate),priority:data.priority};
  `,parameters,reminderSchema,45000);
}

async function openReminder(searchText:string) {
  const matches=await searchReminders(searchText,{limit:2});
  if(!matches.length) throw new Error('Reminder not found');
  if(matches.length>1) throw new Error('Multiple reminders match; use a more specific search');
  const reminder=matches[0];
  await runQuery(`var app=Application('Reminders');var lists=app.lists();
    for(var i=0;i<lists.length;i++){var rs=lists[i].reminders.whose({id:p.id})();
      if(rs.length){app.activate();app.show(rs[0]);return true;}}
    throw new Error('Reminder not found');`,{id:reminder.id},z.boolean(),45000);
  return {success:true,message:'Opened the requested reminder',reminder};
}

async function getRemindersFromListById(listId:string, props?:string[], options:ReminderQueryOptions={}): Promise<Record<string,unknown>[]> {
  if(!listId.trim()) throw new Error("List ID is required");
  if(props && props.some(key => !Object.hasOwn(reminderSchema.shape,key))) throw new Error("Unsupported reminder property");
  const results=await queryReminders(options,undefined,listId);
  return props ? results.map(r => Object.fromEntries(props.map(key => [key,r[key as keyof typeof r]]))) : results;
}

export default {
	getAllLists,
	getAllReminders,
	searchReminders,
	createReminder,
	openReminder,
	getRemindersFromListById,
	requestRemindersAccess,
};
