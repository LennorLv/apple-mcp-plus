import {test,expect} from "bun:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {readFileSync} from "node:fs";
import path from "node:path";
const root=path.resolve(import.meta.dir,"..");
const expected=["contacts","notes","messages","mail","reminders","calendar"].sort();
for(const runtime of ["node","bun"])test(`Plus ${runtime} stdio advertises six tools and rejects every removed Maps method`,async()=>{
 const transport=new StdioClientTransport({command:runtime==="node"?(process.env.APPLE_MCP_NODE || "node"):process.execPath,
  args:[path.join(root,runtime==="node"?"dist/index.js":"index.ts")],cwd:root,stderr:"pipe"});
 transport.stderr?.on("data",()=>{});const client=new Client({name:"plus-inventory-test",version:"1.0.0"});
 try {
  await client.connect(transport);const list=await client.listTools();
  expect(list.tools.map(t=>t.name).sort()).toEqual(expected);
  expect(client.getServerVersion()?.name).toBe("Apple MCP Plus");
  const manifest=JSON.parse(readFileSync(path.join(root,"manifest.json"),"utf8"));
  expect(manifest.name).toBe("apple-mcp-plus");expect(manifest.tools.map((t:{name:string})=>t.name).sort()).toEqual(expected);
  for(const operation of ["search","save","directions","pin","listGuides","addToGuide","createGuide","status","diagnose"]) {
   const r=await client.callTool({name:"maps",arguments:{operation}});
   expect(r.isError).toBe(true);expect(r.content).toEqual([{type:"text",text:"Unknown tool: maps"}]);
  }
 }finally{await client.close();}
},10000);
