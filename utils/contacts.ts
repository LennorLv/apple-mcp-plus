import { z } from "zod";
import { runQuery } from "./jxa-query";

const contactSchema = z.object({id:z.string(),name:z.string(),phones:z.array(z.string())});
async function readContacts() {
  return runQuery(`var app=Application('Contacts');
    if(!app.running()){app.launch();delay(1);}
    var names=app.people.name();var ids=app.people.id();var phones=app.people.phones.value();
    return names.map(function(name,i){return {id:ids[i],name:name,phones:phones[i] || []};});`,
    {},z.array(contactSchema));
}
async function getAllNumbers(): Promise<Record<string,string[]>> {
  const result: Record<string,string[]> = Object.create(null);
  for(const contact of await readContacts()) {
    result[contact.name]=[...new Set([...(result[contact.name] || []),...contact.phones])];
  }
  return result;
}
async function findNumber(name:string):Promise<string[]> {
  return [...new Set((await findContacts(name)).flatMap(c=>c.phones))];
}
async function findContacts(name:string) {
  if(typeof name!=="string" || !name.trim()) throw new Error("Contact name is required");
  const term=name.trim().toLocaleLowerCase();
  return (await readContacts()).filter(c=>c.name.toLocaleLowerCase().includes(term));
}
async function findContactByPhone(phoneNumber:string):Promise<string|null> {
  const normalize=(value:string)=>value.replace(/[^0-9+]/g,"");
  const phone=normalize(phoneNumber);
  if(!phone) return null;
  const matches=(await readContacts()).filter(c=>c.phones.some(p=>normalize(p)===phone));
  return matches.length ? matches.map(c=>c.name).join(", ") : null;
}
async function requestContactsAccess():Promise<{hasAccess:boolean;message:string}> {
  try {
    await runQuery("return Application('Contacts').name();",{},z.string());
    return {hasAccess:true,message:"Contacts automation access is granted."};
  }catch(e){return {hasAccess:false,message:String(e)};}
}
export default {getAllContacts:readContacts,findContacts,getAllNumbers,findNumber,findContactByPhone,requestContactsAccess};
