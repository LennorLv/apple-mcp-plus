import { describe, test, expect, mock, afterAll } from "bun:test";
import { runInNewContext } from "node:vm";
import { buildQueryScript, validateQueryOptions, runQuery, queryOptionsSchema } from "../utils/jxa-query";

const originalExports={buildQueryScript,validateQueryOptions,runQuery,queryOptionsSchema};
afterAll(()=>mock.module("../utils/jxa-query",()=>originalExports));

function collection<T>(items:T[], fields:string[]=[]) {
  const value=Object.assign(()=>items, items);
  for(const field of fields) Object.defineProperty(value,field,{value:()=>items.map((x:any)=>x[field]()),configurable:true});
  Object.defineProperty(value,'slice',{value:(start:number,end:number)=>collection(items.slice(start,end+1),fields),configurable:true});
  return value;
}
const day=(s:string)=>new Date(s);
const messages=[
  {id:1,subject:'Old invoice',date:'2026-10-08T08:00:00Z',body:'old',read:true},
  {id:2,subject:'发票 "quoted", colon:',date:'2026-10-09T15:00:00Z',body:'line1\nline2',read:false},
  {id:3,subject:'newest',date:'2026-10-10T03:00:00Z',body:'invoice in body',read:true},
].map(x=>({id:()=>x.id,subject:()=>x.subject,dateReceived:()=>day(x.date),dateSent:()=>day(x.date),
  content:()=>x.body,readStatus:()=>x.read,sender:()=>"sender@example.test"}));
const box={name:()=>"INBOX",mailboxes:()=>[],messages:collection(messages,["dateReceived","subject","readStatus"])};
const account={name:()=>"Real account",mailboxes:()=>[box]};
messages.forEach(m=>Object.assign(m,{mailbox:()=>({account:()=>account})}));
const noteItems=[
  {id:'old',name:'old note',content:'- [ ] old task',date:'2026-10-08T00:00:00Z'},
  {id:'new',name:'中文 "标题", :',content:'- [x] finished\n- [ ] unfinished\nTODO: verify status',date:'2026-10-10T00:00:00Z'},
].map(x=>({id:()=>x.id,name:()=>x.name,plaintext:()=>x.content,
  creationDate:()=>day(x.date),modificationDate:()=>day(x.date),container:()=>({name:()=>"Folder"})}));
const reminderItems=[false,true].map((done,i)=>({id:()=>String(i),name:()=>i?'finished':'unfinished',
  body:()=>"body",completed:()=>done,dueDate:()=>null,creationDate:()=>day('2026-10-10T00:00:00Z'),
  modificationDate:()=>day('2026-10-10T00:00:00Z'),completionDate:()=>null,remindMeDate:()=>null,priority:()=>0}));
reminderItems.forEach(r=>Object.assign(r,{properties:()=>Object.fromEntries(Object.entries(r).filter(([key])=>key!=="properties").map(([key,value])=>[key,value()]))}));
const fakeApps:any={
  Mail:{accounts:collection([account],["name"]),mailboxes:()=>[],inbox:box},
  Notes:{notes:()=>noteItems,folders:collection([{name:()=>"Folder"}],["name"])},
  Reminders:{running:()=>true,lists:()=>[{id:()=>"list-1",name:()=>"List",reminders:collection(reminderItems,["id","completed","name","body","dueDate","creationDate","modificationDate","completionDate","remindMeDate","priority"])}]},
};
const eventRecords:any[]=[];
const shownEvents:string[]=[];
function eventObject(p:any) {const id=String(eventRecords.length+1);return {uid:()=>id,show:()=>shownEvents.push(id),summary:()=>p.summary,
  location:()=>p.location || '',description:()=>p.description || '',startDate:()=>p.startDate,
  endDate:()=>p.alldayEvent ? new Date(p.endDate.getTime()-1000) : p.endDate,
  alldayEvent:()=>p.alldayEvent || false,url:()=>''};}
const eventCollection:any=()=>eventRecords;
eventCollection.push=(e:any)=>eventRecords.push(e);
eventCollection.whose=(predicate:any)=>()=>eventRecords.filter(e=>{
  if(predicate.uid) return e.uid()===predicate.uid;
  const inRange=e.startDate()<predicate._and[0].startDate._lessThan && e.endDate()>predicate._and[1].endDate._greaterThan;
  const clause=predicate._and[2]?._or;
  return inRange && (!clause || clause.some((rule:any)=>{const [field,value]=Object.entries(rule)[0] as [string,any];return String(e[field]()).toLowerCase().includes(value._contains.toLowerCase());}));
});
const scalarEventFilter=eventCollection.whose;
eventCollection.whose=(predicate:any)=>collection(scalarEventFilter(predicate)(),
  ["uid","summary","location","description","startDate","endDate","alldayEvent","url"]);
const eventPropertiesFields=['uid','summary','location','description','startDate','endDate','alldayEvent','url'];
const priorEventObject=eventObject;
function withProperties(e:any){return Object.assign(e,{properties:()=>Object.fromEntries(eventPropertiesFields.map(key=>[key,e[key]()])),});}
const cal={name:()=>"Fixture calendar",writable:()=>true,events:eventCollection};
fakeApps.Calendar={calendars:()=>[cal],Event:(p:any)=>withProperties(eventObject(p))};
fakeApps.Contacts={running:()=>true,people:{name:()=>['Duplicate','Duplicate','No number'],id:()=>['a','b','c'],
  phones:{value:()=>[['+8613800000000','12345'],['12345','+8613900000000'],[]]}}};
let fail=false;
mock.module("../utils/jxa-query",()=>({buildQueryScript,validateQueryOptions,queryOptionsSchema,
  runQuery:async(body:string,p:unknown,schema:any)=>{
    if(fail) throw new Error("Permission denied");
    const output=runInNewContext(buildQueryScript(body,p),{Application:(name:string)=>fakeApps[name],Date});
    return schema.parse(JSON.parse(output));
  },
}));
const messagesTool=(await import('../utils/message')).default;
const calendar=(await import('../utils/calendar')).default;
const contacts=(await import('../utils/contacts')).default;
const mail=(await import('../utils/mail')).default;
const notes=(await import('../utils/notes')).default;
const reminders=(await import('../utils/reminders')).default;

describe('query regressions without personal data or Apple app writes',()=>{
  test('JSON preserves quotes, newlines and source-looking input',()=>{
    const p={text:'"; throw new Error("injected"); //\n中文, :'};
    expect(JSON.parse(runInNewContext(buildQueryScript('return p;',p)))).toEqual(p);
  });
  test('reject invalid limits, dates and reversed ranges before application access',()=>{
    for(const limit of [0,-1,1.5,101,NaN]) expect(()=>validateQueryOptions({limit})).toThrow();
    expect(()=>validateQueryOptions({fromDate:'yesterday'})).toThrow();
    expect(()=>validateQueryOptions({fromDate:'2026-10-10T00:00:00Z',toDate:'2026-10-09T00:00:00Z'})).toThrow();
  });
  test('returns real account names and globally sorted latest messages',async()=>{
    expect(await mail.getAccounts()).toEqual(['Real account']);
    expect((await mail.getLatestMails(undefined,2)).map(m=>m.id)).toEqual(['3','2']);
  });
  test('date boundaries use received time with timezone and preserve content',async()=>{
    const rows=await mail.searchMails('发票',3,{mailbox:'inbox',fromDate:'2026-10-09T00:00:00+08:00',toDate:'2026-10-10T00:00:00+08:00',account:'Real account'});
    expect(rows.map(r=>r.id)).toEqual(['2']);
    expect(rows[0]!.content).toBe('line1\nline2');
  });
  test('unread filtering and explicit body search return actual matches',async()=>{
    expect((await mail.getUnreadMails()).map(m=>m.id)).toEqual(['2']);
    expect((await mail.searchMails('invoice',3,{searchIn:'all'})).map(m=>m.id)).toEqual(['3','1']);
  });
  test('full-body search stops after newest matches without reading older bodies',async()=>{
    const older=messages[0]!.content;
    messages[0]!.content=()=>{throw Error('Unnecessary older body read');};
    try{expect((await mail.searchMails('invoice',1,{searchIn:'all'})).map(m=>m.id)).toEqual(['3']);}
    finally{messages[0]!.content=older;}
  });
  test('full-body search explicitly rejects an unfinished broad scan',async()=>{
    const original=box.messages;let reads=0;
    box.messages=collection(Array.from({length:105},(_,i)=>({...messages[0],id:()=>i+10,
      content:()=>{reads++;return 'No matching content';}})),['dateReceived','subject','readStatus']) as any;
    try{await expect(mail.searchMails('absent-token',3,{searchIn:'all'})).rejects.toThrow('safe scan budget');expect(reads).toBe(100);}
    finally{box.messages=original;}
  });
  test('missing account or mailbox is an error, never a successful empty result',async()=>{
    await expect(mail.getLatestMails('missing')).rejects.toThrow();
    await expect(mail.searchMails('invoice',3,{mailbox:'missing'})).rejects.toThrow();
  });
  test('structural mail folders do not hide their child mailbox results',async()=>{
    const original=account.mailboxes;
    account.mailboxes=()=>[{name:()=>"Parent",mailboxes:()=>[box],messages:{dateReceived:()=>{
      throw Object.assign(new Error("No messages element"),{errorNumber:-1728});
    }}}] as any;
    try {expect((await mail.searchMails('发票',3,{mailbox:'Parent'})).map(r=>r.id)).toEqual(['2']);}
    finally {account.mailboxes=original;}
  });
  test('notes retain real IDs/content/dates, sort and filter by folder/date',async()=>{
    const rows=await notes.getAllNotes({limit:1,folderName:'Folder'});
    expect(rows[0]!.id).toBe('new'); expect(rows[0]!.content).toContain('unfinished');
    expect((await notes.getNotesByDateRange('Folder','2026-10-09T00:00:00Z')).notes!.length).toBe(1);
    expect((await notes.findNote('unfinished'))[0]!.id).toBe('new');
  });
  test('task matching occurs before note limit; excludes checked tasks and labels ambiguity',async()=>{
    const result=await notes.getTextTasks({limit:1});
    expect(result.matchingNotes).toBe(2); expect(result.notes.length).toBe(1);
    expect(result.notes[0]!.tasks.map(t=>t.status)).toEqual(['unchecked-text','unverified']);
    expect(result.nativeChecklistStatus).toBe('unavailable');
  });
  test('reminder completion filter and ID projection use actual records',async()=>{
    expect((await reminders.getAllReminders(undefined,{completed:false})).map(r=>r.id)).toEqual(['0']);
    expect(await reminders.getRemindersFromListById('list-1',['id','completed'],{completed:false})).toEqual([{id:'0',completed:false}]);
    expect((await reminders.searchReminders('unfinished')).length).toBe(1);
    await expect(reminders.getRemindersFromListById('missing')).rejects.toThrow();
    await expect(reminders.getRemindersFromListById('list-1',['constructor'])).rejects.toThrow();
  });
  test('large unfiltered reminder queries bound field reads and preserve sparse filters',async()=>{
    const original=fakeApps.Reminders.lists;
    let perRecordCalls=0;
    const many=Array.from({length:150},(_,i)=>({...reminderItems[i%2],id:()=>String(i),
      properties:()=>{perRecordCalls++;return {...(reminderItems[i%2] as any).properties(),id:String(i)};}}));
    fakeApps.Reminders.lists=()=>[{id:()=>"large",name:()=>"Large",reminders:collection(many,
      ["id","completed","name","body","dueDate","creationDate","modificationDate","completionDate","remindMeDate","priority"])}];
    try {
      expect((await reminders.getAllReminders(undefined,{limit:100})).map(r=>r.id)).toEqual(Array.from({length:100},(_,i)=>String(i)));
      expect(perRecordCalls).toBe(100); // bounded object reads; no truncation sentinel properties
      expect((await reminders.getAllReminders(undefined,{completed:false,limit:100})).length).toBe(75);
      expect((await reminders.searchReminders('finished',{completed:true,limit:1}))[0]!.id).toBe('1');
    } finally {fakeApps.Reminders.lists=original;}
  });
  test('contacts merge duplicate names and deduplicate all their numbers',async()=>{
    expect(await contacts.getAllNumbers()).toEqual({Duplicate:['+8613800000000','12345','+8613900000000'],'No number':[]});
    expect(await contacts.findNumber('plic')).toEqual(['+8613800000000','12345','+8613900000000']);
    expect(await contacts.findNumber('missing')).toEqual([]);
  });
  test('calendar writes offset dates and all fields without localized date parsing',async()=>{
    const e=await calendar.createEvent('中文 "quoted"','2026-10-12T10:00:00+08:00','2026-10-12T11:00:00+08:00','地点','line1\nline2',false,'Fixture calendar');
    expect(e.event.startDate).toBe('2026-10-12T02:00:00.000Z');
    expect(e.event.endDate).toBe('2026-10-12T03:00:00.000Z');expect(e.event.notes).toBe('line1\nline2');
    expect((await calendar.searchEvents('line2',10,'2026-10-12T00:00:00Z','2026-10-13T00:00:00Z')).some(x=>x.id===e.eventId)).toBe(true);
  });
  test('calendar all-day native inclusive end becomes exclusive and remains queryable in last half second',async()=>{
    const start=new Date(2026,9,14).toISOString(),end=new Date(2026,9,15).toISOString();
    const e=await calendar.createEvent('All day',start,end,undefined,undefined,true,'Fixture calendar');
    expect(e.event.endDate).toBe(end);
    expect((await calendar.getEvents(10,new Date(Date.parse(end)-500).toISOString(),new Date(Date.parse(end)+1000).toISOString())).some(x=>x.id===e.eventId)).toBe(true);
    expect((await calendar.getEvents(10,end,new Date(Date.parse(end)+86400000).toISOString())).some(x=>x.id===e.eventId)).toBe(false);
  });
  test('calendar invalid dates and absent calendar leave no new event',async()=>{
    const before=eventRecords.length;
    await expect(calendar.createEvent('Invalid','2026-10-12T03:00:00Z','2026-10-12T02:00:00Z')).rejects.toThrow();
    await expect(calendar.createEvent('Invalid','2026-10-12T02:00:00Z','2026-10-12T03:00:00Z',undefined,undefined,false,'missing')).rejects.toThrow();
    expect(eventRecords.length).toBe(before);
  });
  test('calendar opening navigates to the real event day and shows that event instance',async()=>{
    const calls:any[]=[];
    Object.assign(fakeApps.Calendar,{activate:()=>calls.push('activate'),switchView:(p:any)=>calls.push(p.to),
      viewCalendar:(p:any)=>calls.push(p.at.toISOString())});
    const e=await calendar.createEvent('Open target','2026-10-12T02:00:00Z','2026-10-12T03:00:00Z',undefined,undefined,false,'Fixture calendar');
    const result=await calendar.openEvent(e.eventId);
    expect(result.eventId).toBe(e.eventId);expect(shownEvents.at(-1)).toBe(e.eventId);
    expect(calls).toEqual(['activate','day view','2026-10-12T02:00:00.000Z']);
  });
  test('mail sending preserves literal body/subject and all recipients without temporary files',async()=>{
    const drafts:any[]=[];const sent:any[]=[];
    Object.assign(fakeApps.Mail,{OutgoingMessage:(p:any)=>({...p,toRecipients:[],ccRecipients:[],bccRecipients:[]}),
      outgoingMessages:{push:(m:any)=>drafts.push(m)},ToRecipient:(p:any)=>p,CcRecipient:(p:any)=>p,BccRecipient:(p:any)=>p,
      send:(m:any)=>{sent.push(m);return true;}});
    await mail.sendMail('one@example.invalid,two@example.invalid','中文 "subject"','line1\n<script>& "quoted"','cc@example.invalid','bcc@example.invalid');
    expect(sent[0].subject).toBe('中文 "subject"');expect(sent[0].content).toBe('line1\n<script>& "quoted"');
    expect(sent[0].toRecipients.map((r:any)=>r.address)).toEqual(['one@example.invalid','two@example.invalid']);
    expect(sent[0].ccRecipients[0].address).toBe('cc@example.invalid');expect(sent[0].bccRecipients[0].address).toBe('bcc@example.invalid');
    const before=drafts.length;await expect(mail.sendMail('invalid','title','body')).rejects.toThrow();expect(drafts.length).toBe(before);
    await expect(mail.sendMail('one@example.invalid','title',' \n ')).rejects.toThrow();expect(drafts.length).toBe(before);
  });
  test('message sending binds recipient to enabled iMessage account and preserves multiline text',async()=>{
    const sent:any[]=[];
    fakeApps.Messages={accounts:{whose:(predicate:any)=>{
      if(predicate.serviceType!==undefined)throw Object.assign(Error('Cannot convert type'),{errorNumber:-1700});
      return ()=>[
        {serviceType:()=>{throw Object.assign(Error('Relay account'),{errorNumber:-10000});}},
        {serviceType:()=> 'SMS'},
        {serviceType:()=> 'iMessage',participants:{byName:(address:string)=>({address})}}
      ];}},
      send:(text:string,args:any)=>sent.push({text,address:args.to.address})};
    await messagesTool.sendMessage('+8613800000000','中文 "quoted"\nsecond line');
    expect(sent).toEqual([{text:'中文 "quoted"\nsecond line',address:'+8613800000000'}]);
    await expect(messagesTool.sendMessage('invalid','body')).rejects.toThrow();expect(sent.length).toBe(1);
    await expect(messagesTool.sendMessage('+8613800000000',' \n ')).rejects.toThrow();expect(sent.length).toBe(1);
    await messagesTool.sendMessage('+86 (138) 0000-0000','格式规范化');
    expect(sent.at(-1).address).toBe('+8613800000000');
  });
  test('scheduler rejects past, invalid and overflowing timers before any send',async()=>{
    for(const date of [new Date(Date.now()-1000),new Date('invalid'),new Date(Date.now()+2147483648+10000)])
      await expect(messagesTool.scheduleMessage('+8613800000000','fixture',date)).rejects.toThrow();
  });
  test('application failure propagates instead of being converted into an empty array',async()=>{
    fail=true;
    try {await expect(mail.getAccounts()).rejects.toThrow('Permission denied');
      await expect(notes.getAllNotes()).rejects.toThrow('Permission denied');
      await expect(reminders.getAllLists()).rejects.toThrow('Permission denied');
    } finally {fail=false;}
  });
});
