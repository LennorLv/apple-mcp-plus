import { runAppleScript } from "run-applescript";
import { z } from "zod";
import { runQuery, validateQueryOptions } from "./jxa-query";

const emailSchema = z.object({
  id: z.string(), subject: z.string(), sender: z.string(), dateSent: z.string(),
  dateReceived: z.string(), content: z.string(), contentTruncated: z.boolean(),
  isRead: z.boolean(), mailbox: z.string(), account: z.string(),
});
export type EmailMessage = z.infer<typeof emailSchema>;
export interface MailQueryOptions {
  account?: string; mailbox?: string; fromDate?: string; toDate?: string;
  searchIn?: "subject" | "all";
}

const mailboxHelpers = `
  var app = Application('Mail');
  var accounts = app.accounts();
  if (p.account) {
    accounts = accounts.filter(function(a) { return a.name() === p.account; });
    if (!accounts.length) throw new Error('Email account not found');
  }
  var boxes = [];
  function walk(items, account, prefix) {
    items.forEach(function(b) {
      var name = b.name(); var path = prefix ? prefix + '/' + name : name;
      var children = b.mailboxes();
      boxes.push({box:b, account:account, name:name, path:path, hasChildren:children.length>0});
      walk(children, account, path);
    });
  }
  accounts.forEach(function(a) { walk(a.mailboxes(), a.name(), ''); });
  if (!p.account) walk(app.mailboxes(), 'On My Mac', '');
`;

async function queryMails(operation: "latest" | "unread" | "search", limit: number,
  options: MailQueryOptions = {}, searchTerm?: string): Promise<EmailMessage[]> {
  validateQueryOptions({ limit, fromDate: options.fromDate, toDate: options.toDate });
  const parameters = z.object({
    operation: z.enum(["latest", "unread", "search"]), limit: z.number(),
    account: z.string().min(1).optional(), mailbox: z.string().min(1).optional(),
    fromDate: z.string().optional(), toDate: z.string().optional(),
    searchIn: z.enum(["subject", "all"]).optional(), searchTerm: z.string().optional(),
  }).parse({ ...options, operation, limit, searchTerm });
  return runQuery(mailboxHelpers + `
    var scope = p.mailbox || (p.operation === 'search' ? 'all' : 'inbox');
    if (scope.toLowerCase() === 'inbox' && !p.account) {
      boxes = [{box:app.inbox, account:null, name:'Inbox', path:'Inbox'}];
    } else if (scope.toLowerCase() === 'inbox') {
      boxes = boxes.filter(function(b) { return /^(inbox|收件箱|收件匣)$/i.test(b.name); });
    } else if (scope.toLowerCase() !== 'all') {
      boxes = boxes.filter(function(b) {
        return b.name === scope || b.path === scope || b.path.indexOf(scope + '/') === 0;
      });
    }
    if (!boxes.length && scope.toLowerCase() !== 'all') throw new Error('Mailbox not found');
    var from = p.fromDate ? Date.parse(p.fromDate) : -Infinity;
    var to = p.toDate ? Date.parse(p.toDate) : Infinity;
    var term = (p.searchTerm || '').toLowerCase();
    var candidates = [];
    boxes.forEach(function(b) {
      var dates;
      try { dates = b.box.messages.dateReceived(); }
      catch (e) {
        // Mail also exposes structural folders (e.g. Notes) as mailboxes.
        // Their messages element does not exist; their child boxes are queried separately.
        if (b.hasChildren && e.errorNumber === -1728) return;
        throw e;
      }
      var subjects = p.operation === 'search' ? b.box.messages.subject() : [];
      var read = p.operation === 'unread' ? b.box.messages.readStatus() : [];
      dates.forEach(function(date, i) {
        var time = date.getTime();
        if (time < from || time >= to || (p.operation === 'unread' && read[i])) return;
        var message = b.box.messages[i];
        if (p.operation === 'search' && (subjects[i] || '').toLowerCase().indexOf(term) < 0) {
          if (p.searchIn !== 'all') return;
        }
        candidates.push({message:message, time:time, box:b, subject:subjects[i] || ''});
      });
    });
    candidates.sort(function(a,b) { return b.time - a.time; });
    var seen = {}; var results = [];
    var bodyReads=0; var bodyDeadline=Date.now()+10000;
    for (var i=0; i<candidates.length && results.length<p.limit; i++) {
      var c=candidates[i]; var m=c.message;
      var account=c.box.account;
      if (account === null) account=m.mailbox().account().name();
      var id=String(m.id()); var key=account + ':' + id;
      if (seen[key]) continue;
      seen[key]=true;
      var text;
      if(p.operation==='search' && c.subject.toLowerCase().indexOf(term)<0) {
        // Scan newest candidates first and stop once limit matches are found.
        // Never silently return incomplete results after an exhaustive scan fails.
        if(bodyReads>=100 || Date.now()>bodyDeadline)
          throw new Error('Full-text search exceeded the safe scan budget; narrow mailbox/fromDate/toDate or use searchIn=subject');
        bodyReads++; text=m.content();
        if(text.toLowerCase().indexOf(term)<0)continue;
      }
      if(text===undefined)text=m.content();
      results.push({id:id, subject:m.subject() || '', sender:m.sender() || '',
        dateSent:m.dateSent().toISOString(), dateReceived:new Date(c.time).toISOString(),
        content:text.slice(0,500), contentTruncated:text.length>500,
        isRead:m.readStatus(), mailbox:c.box.path, account:account});
    }
    return results;
  `, parameters, z.array(emailSchema));
}

async function getUnreadMails(limit = 10, options: MailQueryOptions = {}) {
  return queryMails("unread", limit, options);
}
async function searchMails(searchTerm: string, limit = 10, options: MailQueryOptions = {}) {
  if (!searchTerm.trim()) throw new Error("Search term is required");
  return queryMails("search", limit, options, searchTerm);
}
async function getLatestMails(account?: string, limit = 5, options: MailQueryOptions = {}) {
  return queryMails("latest", limit, { ...options, account });
}
async function getAccounts(): Promise<string[]> {
  return runQuery("return Application('Mail').accounts.name();", {}, z.array(z.string()));
}
async function getMailboxes(account?: string): Promise<string[]> {
  return runQuery(mailboxHelpers + "return boxes.map(function(b) { return b.path; });",
    { account }, z.array(z.string()));
}
async function getMailboxesForAccount(account: string): Promise<string[]> {
  if (!account.trim()) throw new Error("Account name is required");
  return getMailboxes(account);
}

async function checkMailAccess(): Promise<boolean> {
	try {
		const script = `
tell application "Mail"
    return name
end tell`;

		await runAppleScript(script);
		return true;
	} catch (error) {
		console.error(
			`Cannot access Mail app: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * Request Mail app access and provide instructions if not available
 */
async function requestMailAccess(): Promise<{ hasAccess: boolean; message: string }> {
	try {
		// First check if we already have access
		const hasAccess = await checkMailAccess();
		if (hasAccess) {
			return {
				hasAccess: true,
				message: "Mail access is already granted."
			};
		}

		// If no access, provide clear instructions
		return {
			hasAccess: false,
			message: "Mail access is required but not granted. Please:\n1. Open System Settings > Privacy & Security > Automation\n2. Find your terminal/app in the list and enable 'Mail'\n3. Make sure Mail app is running and configured with at least one account\n4. Restart your terminal and try again"
		};
	} catch (error) {
		return {
			hasAccess: false,
			message: `Error checking Mail access: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

async function sendMail(to:string,subject:string,body:string,cc?:string,bcc?:string):Promise<string> {
  const recipients=(value:string|undefined)=>value===undefined?[]:value.split(/[,;]/).map(v=>v.trim());
  const p=z.object({to:z.array(z.string().email()).min(1),cc:z.array(z.string().email()),
    bcc:z.array(z.string().email()),subject:z.string().trim().min(1),body:z.string().refine(value=>value.trim().length>0,'Body is required')})
    .parse({to:recipients(to),cc:recipients(cc),bcc:recipients(bcc),subject,body});
  await runQuery(`var app=Application('Mail');
    var message=app.OutgoingMessage({subject:p.subject,content:p.body,visible:true});
    app.outgoingMessages.push(message);
    p.to.forEach(function(address){message.toRecipients.push(app.ToRecipient({address:address}));});
    p.cc.forEach(function(address){message.ccRecipients.push(app.CcRecipient({address:address}));});
    p.bcc.forEach(function(address){message.bccRecipients.push(app.BccRecipient({address:address}));});
    if(!app.send(message)) throw new Error('Mail did not accept the send request');
    return true;`,p,z.literal(true),45000);
  return 'Mail accepted the send request; recipient delivery still requires confirmation.';
}


export default { getUnreadMails, searchMails, getLatestMails, getAccounts,
  getMailboxes, getMailboxesForAccount, sendMail, requestMailAccess };
