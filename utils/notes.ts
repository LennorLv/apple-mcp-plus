import { runAppleScript } from "run-applescript";
import { z } from "zod";
import { runQuery, validateQueryOptions } from "./jxa-query";
import { readNativeChecklists } from "./notes-checklist";

// Configuration
const CONFIG = {
	// Maximum notes to process (to avoid performance issues)
	MAX_NOTES: 50,
	// Maximum content length for previews
	MAX_CONTENT_PREVIEW: 200,
	// Timeout for operations
	TIMEOUT_MS: 8000,
};

type Note = {
	name: string;
	content: string;
	id?: string;
	folderName?: string;
	contentTruncated?: boolean;
	creationDate?: string;
	modificationDate?: string;
};

type CreateNoteResult = {
	success: boolean;
	note?: Note;
	message?: string;
	folderName?: string;
	usedDefaultFolder?: boolean;
  createdFolder?: boolean;
};

/**
 * Check if Notes app is accessible
 */
async function checkNotesAccess(): Promise<boolean> {
	try {
		const script = `
tell application "Notes"
    return name
end tell`;

		await runAppleScript(script);
		return true;
	} catch (error) {
		console.error(
			`Cannot access Notes app: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * Request Notes app access and provide instructions if not available
 */
async function requestNotesAccess(): Promise<{ hasAccess: boolean; message: string }> {
	try {
		// First check if we already have access
		const hasAccess = await checkNotesAccess();
		if (hasAccess) {
			return {
				hasAccess: true,
				message: "Notes access is already granted."
			};
		}

		// If no access, provide clear instructions
		return {
			hasAccess: false,
			message: "Notes access is required but not granted. Please:\n1. Open System Settings > Privacy & Security > Automation\n2. Find your terminal/app in the list and enable 'Notes'\n3. Restart your terminal and try again\n4. If the option is not available, run this command again to trigger the permission dialog"
		};
	} catch (error) {
		return {
			hasAccess: false,
			message: `Error checking Notes access: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

/**
 * Get all notes from Notes app (limited for performance)
 */
export interface NotesQueryOptions {
  limit?: number; folderName?: string; fromDate?: string; toDate?: string;
  sortBy?: "creationDate" | "modificationDate"; sortOrder?: "asc" | "desc";
  contentLimit?: number;
}
const notesOptionsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  folderName: z.string().min(1).optional(), fromDate: z.string().optional(),
  toDate: z.string().optional(), sortBy: z.enum(["creationDate", "modificationDate"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  contentLimit: z.number().int().min(1).max(100000).optional(),
});
const noteSchema = z.object({id:z.string(), name:z.string(), content:z.string(),
  folderName:z.string(), creationDate:z.string(), modificationDate:z.string(),
  contentTruncated:z.boolean()});
const notesReadScript = `
  var app=Application('Notes'); var all=app.notes();
  if (p.folderName && app.folders.name().indexOf(p.folderName)<0) throw new Error('Notes folder not found');
  var field=p.sortBy || 'modificationDate';
  var from=p.fromDate ? Date.parse(p.fromDate) : -Infinity;
  var to=p.toDate ? Date.parse(p.toDate) : Infinity;
  var records=[];
  all.forEach(function(n) {
    var folder=n.container().name();
    if (p.folderName && folder!==p.folderName) return;
    if (!p.folderName && ['Recently Deleted','最近删除'].indexOf(folder)>=0) return;
    var date=field==='creationDate' ? n.creationDate() : n.modificationDate();
    var time=date.getTime(); if (time<from || time>=to) return;
    var text;
    if (p.searchText) {
      text=n.plaintext();
      var term=p.searchText.toLowerCase();
      if (n.name().toLowerCase().indexOf(term)<0 && text.toLowerCase().indexOf(term)<0) return;
    }
    records.push({note:n, time:time, folder:folder, text:text});
  });
  records.sort(function(a,b) {return (p.sortOrder==='asc' ? 1 : -1)*(a.time-b.time);});
  return records.slice(0,p.limit || 50).map(function(r) {
    var n=r.note; var text=r.text===undefined ? n.plaintext() : r.text;
    var cap=p.contentLimit || 2000;
    return {id:n.id(), name:n.name(), content:text.slice(0,cap), contentTruncated:text.length>cap,
      folderName:r.folder, creationDate:n.creationDate().toISOString(), modificationDate:n.modificationDate().toISOString()};
  });
`;
async function queryNotes(options: NotesQueryOptions = {}, searchText?: string) {
  const parameters=notesOptionsSchema.parse(options);
  validateQueryOptions(parameters);
  return runQuery(notesReadScript, {...parameters,searchText}, z.array(noteSchema));
}
async function getAllNotes(options: NotesQueryOptions = {}): Promise<Note[]> {
  return queryNotes(options);
}
async function findNote(searchText: string, options: NotesQueryOptions = {}): Promise<Note[]> {
  if (!searchText.trim()) throw new Error("Search text is required");
  return queryNotes(options, searchText);
}

export function extractTextTasks(content: string) {
  return content.split(/\r?\n/).flatMap<{line:number;text:string;status:"unchecked-text"|"unverified"}>((line, index) => {
    const text=line.trim();
    if (/^(?:[-*+]\s*)?\[x\]/i.test(text) || /^☑/.test(text)) return [];
    if (/^(?:[-*+]\s*)?\[ \]/.test(text) || /^☐/.test(text)) {
      return [{line:index+1, text:text.replace(/^(?:[-*+]\s*)?\[ \]\s*|^☐\s*/, ""), status:"unchecked-text" as const}];
    }
    if (/^(?:[-*+]\s*)?(?:TODO|待办|未完成)\s*[:：]/i.test(text)) {
      return [{line:index+1,text,status:"unverified" as const}];
    }
    return [];
  });
}
async function getTextTasks(options: NotesQueryOptions = {}) {
  const parameters=notesOptionsSchema.parse(options);
  validateQueryOptions(parameters);
  // Scan complete plaintext before applying the result limit or content preview.
  const source=await runQuery(notesReadScript.replace('records.slice(0,p.limit || 50)', 'records'),
    {...parameters,contentLimit:2147483647}, z.array(noteSchema));
  const native=await readNativeChecklists(source);
  const unavailable=source.filter(n => native.get(n.id)?.status!=="available");
  const matches=source.map(n => {
    const checklist=native.get(n.id)!;
    const nativeLines=new Set(checklist.items.map(t => t.line));
    const tasks=[...extractTextTasks(n.content).filter(t => !nativeLines.has(t.line)),
      ...checklist.items.filter(t => !t.checked).map(t => ({line:t.line,text:t.text,status:"unchecked-native" as const}))]
      .sort((a,b) => a.line-b.line);
    return {id:n.id,name:n.name,modificationDate:n.modificationDate,tasks,
      nativeChecklist:checklist.items,nativeChecklistStatus:checklist.status};
  }).filter(n => n.tasks.length);
  const nativeChecklistStatus=unavailable.length===0 ? "available" : unavailable.length===source.length ? "unavailable" : "partial";
  return {notes:matches.slice(0,parameters.limit || 50), matchingNotes:matches.length,
    nativeChecklistStatus,nativeChecklistSource:"notes-database" as const,
    unavailableNotes:unavailable.map(n => ({id:n.id,reason:native.get(n.id)?.error})),
    warning:"Native check states are read from the locally saved Notes database; pending editor changes or remote sync may not be saved yet. Plaintext TODO keywords are unverified." +
      (unavailable.length ? " Some native states could not be read; zero matches does not prove there are no unfinished items." : "")};
}

/**
 * Create a new note
 */
async function createNote(title:string,body:string,folderName?:string):Promise<CreateNoteResult> {
  const p=z.object({title:z.string().trim().min(1),body:z.string(),folderName:z.string().trim().min(1)})
    .parse({title,body,folderName:folderName ?? 'Claude'});
  const result=await runQuery(`
    var app=Application('Notes');var folders=app.folders().filter(function(f){return f.name()===p.folderName;});
    var createdFolder=false;
    if(!folders.length && (p.folderName==='Claude' || p.folderName==='Test-Claude')){
      var folder=app.Folder({name:p.folderName});app.folders.push(folder);folders=[folder];createdFolder=true;}
    if(!folders.length) throw new Error('Notes folder not found');
    if(folders.length!==1) throw new Error('Notes folder name is ambiguous');
    function html(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/\\r?\\n/g,'<br>');}
    var n=app.Note({name:p.title,body:'<div>'+html(p.body)+'</div>'});folders[0].notes.push(n);
    return {createdFolder:createdFolder,note:{id:n.id(),name:n.name(),content:n.plaintext(),contentTruncated:false,
      folderName:n.container().name(),creationDate:n.creationDate().toISOString(),
      modificationDate:n.modificationDate().toISOString()}};`,p,z.object({note:noteSchema,createdFolder:z.boolean()}));
  return {success:true,note:result.note,folderName:result.note.folderName,
    usedDefaultFolder:folderName===undefined,createdFolder:result.createdFolder};
}

async function getNotesFromFolder(folderName: string): Promise<{success:boolean;notes?:Note[];message?:string}> {
  return {success:true, notes:await queryNotes({folderName})};
}
async function getRecentNotesFromFolder(folderName: string, limit=5): Promise<{success:boolean;notes?:Note[];message?:string}> {
  return {success:true, notes:await queryNotes({folderName,limit,sortBy:"modificationDate"})};
}
async function getNotesByDateRange(folderName: string, fromDate?: string, toDate?: string, limit=20): Promise<{success:boolean;notes?:Note[];message?:string}> {
  return {success:true, notes:await queryNotes({folderName,fromDate,toDate,limit})};
}

export default {
	getAllNotes,
	getTextTasks,
	findNote,
	createNote,
	getNotesFromFolder,
	getRecentNotesFromFolder,
	getNotesByDateRange,
	requestNotesAccess,
};
