import { test, expect } from "bun:test";
import { EventKitClient, NativeError, errorResult } from "../utils/eventkit";
import { readArgsSchema, readQuery } from "../utils/query-api";

const program = `
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const p=JSON.parse(line);
 if(p.operation==='exit'){process.exit(0);return;}
 if(p.operation==='malformed'){console.log('not-json');return;}
 if(p.operation==='wrong-id'){console.log(JSON.stringify({requestId:'wrong',success:true,result:{}}));return;}
 if(p.operation==='oversize'){console.log('x'.repeat(9*1024*1024));return;}
 if(p.operation==='wait')return;
 setTimeout(()=>console.log(JSON.stringify(p.operation==='deny'?
 {requestId:p.requestId,success:false,error:{code:'permission_denied',message:'test denied'}}:
 {requestId:p.requestId,success:true,result:{echo:p.parameters}})),p.parameters.delay||0);
});`;
const makeClient=()=>new EventKitClient(process.execPath,["-e",program]);

test("native protocol correlates concurrent responses and preserves literal input",async()=>{
  const client=makeClient();
  try {
    const values=Array.from({length:20},(_,i)=>({index:i,delay:(20-i)*2,text:'中文 "quotes"\n🍎; $(literal)'}));
    const results=await Promise.all(values.map(p=>client.call("echo",p,4000)));
    results.forEach((r,i)=>expect(r.echo).toEqual(values[i]));
  } finally {client.close();}
});
test("permission failure remains an error; successful empty result is distinct",async()=>{
  const client=makeClient();
  try {
    await expect(client.call("deny",{},4000)).rejects.toMatchObject({code:"permission_denied"});
    expect(await client.call("echo",{},4000)).toEqual({echo:{}});
    expect(errorResult(new NativeError("permission_denied","test denied")).structuredContent.error.code).toBe("permission_denied");
  } finally {client.close();}
});
test("deadline cancels outstanding calls; next explicit call restarts the helper",async()=>{
  const client=makeClient();
  try {
    const first=client.call("wait",{},100);
    const queued=client.call("wait",{},2000);
    const results=await Promise.allSettled([first,queued]);
    expect(results.map(r=>r.status)).toEqual(["rejected","rejected"]);
    for(const r of results) if(r.status==="rejected")expect(r.reason.code).toBe("timeout");
    expect(await client.call("echo",{afterRestart:true},4000)).toEqual({echo:{afterRestart:true}});
  } finally {client.close();}
});
test("malformed data, mismatched IDs and oversized response reject and terminate the helper",async()=>{
  for(const operation of ["malformed","wrong-id","oversize"]) {
    const client=makeClient();
    try {await expect(client.call(operation,{},4000)).rejects.toMatchObject({code:"protocol_error"});}
    finally {client.close();}
  }
});
test("early exit and explicit shutdown are reported rather than hanging",async()=>{
  const client=makeClient();
  try {await expect(client.call("exit",{},4000)).rejects.toMatchObject({code:"helper_exited"});}
  finally {client.close();}
  const closed=makeClient();
  const pending=closed.call("wait",{},4000);closed.close();
  await expect(pending).rejects.toMatchObject({code:"cancelled"});
});
test("missing helper fails explicitly without fallback to another backend",async()=>{
  const client=new EventKitClient("/private/tmp/apple-mcp-absent-helper");
  await expect(client.call("echo")).rejects.toMatchObject({code:"helper_unavailable"});
});
test("query validation rejects bad date/ID scopes and accepts explicit backend selection",()=>{
  for(const p of [
    {operation:"search"}, {operation:"listById"}, {operation:"getById"},
    {operation:"list",limit:101}, {operation:"list",backend:"auto"}, {operation:"list",unknownFilter:"ignored"},
    {operation:"list",calendarId:"a",calendarIds:["b"]},
    {operation:"list",fromDate:"2026-10-12T00:00:00Z",toDate:"2026-10-11T00:00:00Z"},
    {operation:"list",fromDate:"2026-10-11T00:00:00"},
  ]) expect(readArgsSchema.safeParse(p).success).toBe(false);
  expect(readArgsSchema.safeParse({operation:"list",backend:"eventkit",completed:false,listId:"exact"}).success).toBe(true);
  expect(readArgsSchema.parse({operation:"search",searchText:" 受控测试\n ",listName:" exact "}).searchText).toBe(" 受控测试\n ");
  expect(readArgsSchema.parse({operation:"list",listName:" exact "}).listName).toBe(" exact ");
});
test("unsupported tool filters and native-only operations reject before application access",async()=>{
  await expect(readQuery("calendar",{operation:"list",completed:false})).rejects.toMatchObject({code:"invalid_arguments"});
  await expect(readQuery("reminders",{operation:"list",fromDate:"2026-10-11T00:00:00Z"})).rejects.toMatchObject({code:"invalid_arguments"});
  await expect(readQuery("calendar",{operation:"calendars",backend:"jxa"})).rejects.toMatchObject({code:"unsupported"});
  await expect(readQuery("reminders",{operation:"listById",listId:"exact",props:["bogus"]})).rejects.toMatchObject({code:"invalid_arguments"});
});
