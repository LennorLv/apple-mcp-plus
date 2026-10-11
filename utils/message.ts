import {runAppleScript} from 'run-applescript';
import {runQuery} from './jxa-query';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';

const execute = promisify(execFile);
async function executeSQLite(query:string) {
  try {
    return await execute('sqlite3',['-readonly','-json',`${process.env.HOME}/Library/Messages/chat.db`,query],
      {timeout:15000,killSignal:'SIGKILL',maxBuffer:8*1024*1024});
  }catch(error){const e=error as {stderr?:string;killed?:boolean};
    throw new Error(e.killed?'Messages database query timed out':
      `Messages database read failed: ${e.stderr?.trim() || 'Unable to read chat.db'}`);
  }
}

// Configuration
const CONFIG = {
    // Maximum messages to process (to avoid performance issues)
    MAX_MESSAGES: 100,
    // Maximum content length for previews
    MAX_CONTENT_PREVIEW: 300,
    // Timeout for operations
    TIMEOUT_MS: 8000
};

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryOperation<T>(operation: () => Promise<T>, retries = MAX_RETRIES, delay = RETRY_DELAY): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (retries > 0) {
            console.error(`Operation failed, retrying... (${retries} attempts remaining)`);
            await sleep(delay);
            return retryOperation(operation, retries - 1, delay);
        }
        throw error;
    }
}

function normalizePhoneNumber(phone:string):string[] {
  const raw=phone.trim();
  if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return [raw.toLowerCase()];
  const cleaned=raw.replace(/[\s().-]/g,'');
  if(!/^\+?\d{3,32}$/.test(cleaned)) throw new Error('Valid phone number or iMessage email is required');
  const formats=new Set<string>([cleaned]);
  if(cleaned.startsWith('+')) formats.add(cleaned.slice(1));
  else if(/^1[3-9]\d{9}$/.test(cleaned)) formats.add('+86'+cleaned);
  else if(cleaned.length===10) formats.add('+1'+cleaned);
  else formats.add('+'+cleaned);
  return [...formats];
}

async function sendMessage(phoneNumber:string,message:string) {
  const p=z.object({phoneNumber:z.string().trim().min(1),message:z.string().refine(value=>value.trim().length>0,'Message is required')}).parse({phoneNumber,message});
  p.phoneNumber=normalizePhoneNumber(p.phoneNumber)[0]!;
  return runQuery(`var app=Application('Messages');
    // Messages rejects serviceType string predicates (-1700) on recent macOS.
    // Some enabled relay accounts also fail serviceType reads (-10000).
    var accounts=app.accounts.whose({enabled:true})();
    var account;
    for(var i=0;i<accounts.length;i++) {
      try {if(String(accounts[i].serviceType())==='iMessage'){account=accounts[i];break;}}
      catch(e){if(e.errorNumber!==-10000)throw e;}
    }
    if(!account) throw new Error('Enabled iMessage account not found');
    var target=account.participants.byName(p.phoneNumber);
    app.send(p.message,{to:target});return true;`,p,z.literal(true),45000);
}

interface Message {
    content: string;
    date: string;
    sender: string;
    is_from_me: boolean;
    attachments?: string[];
    url?: string;
}

async function checkMessagesDBAccess(): Promise<boolean> {
    try {
        const dbPath = `${process.env.HOME}/Library/Messages/chat.db`;
        await access(dbPath);

        // Additional check - try to query the database
        await executeSQLite('SELECT 1;');

        return true;
    } catch (error) {
        console.error(`
Error: Cannot access Messages database.
To fix this, please grant Full Disk Access to Terminal/iTerm2:
1. Open System Preferences
2. Go to Security & Privacy > Privacy
3. Select "Full Disk Access" from the left sidebar
4. Click the lock icon to make changes
5. Add Terminal.app or iTerm.app to the list
6. Restart your terminal and try again

Error details: ${error instanceof Error ? error.message : String(error)}
`);
        return false;
    }
}

/**
 * Request Messages access and provide instructions if not available
 */
async function requestMessagesAccess(): Promise<{ hasAccess: boolean; message: string }> {
    try {
        // Check database access first
        const hasDBAccess = await checkMessagesDBAccess();
        if (hasDBAccess) {
            return {
                hasAccess: true,
                message: "Messages access is already granted."
            };
        }

        // If no database access, check if Messages app is at least accessible
        try {
            await runAppleScript('tell application "Messages" to return name');
            return {
                hasAccess: false,
                message: "Messages app is accessible but database access is required. Please:\n1. Open System Settings > Privacy & Security > Full Disk Access\n2. Add your terminal application (Terminal.app or iTerm.app)\n3. Restart your terminal and try again\n4. Note: This is required to read message history from the Messages database"
            };
        } catch (error) {
            return {
                hasAccess: false,
                message: "Messages access is required but not granted. Please:\n1. Open System Settings > Privacy & Security > Automation\n2. Find your terminal/app and enable 'Messages'\n3. Also grant Full Disk Access in Privacy & Security > Full Disk Access\n4. Restart your terminal and try again"
            };
        }
    } catch (error) {
        return {
            hasAccess: false,
            message: `Error checking Messages access: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

function decodeAttributedBody(hexString: string): { text: string; url?: string } {
    try {
        // Convert hex to buffer
        const buffer = Buffer.from(hexString, 'hex');
        const content = buffer.toString();

        // Common patterns in attributedBody
        const patterns = [
            /NSString">(.*?)</,           // Basic NSString pattern
            /NSString">([^<]+)/,          // NSString without closing tag
            /NSNumber">\d+<.*?NSString">(.*?)</,  // NSNumber followed by NSString
            /NSArray">.*?NSString">(.*?)</,       // NSString within NSArray
            /"string":\s*"([^"]+)"/,      // JSON-style string
            /text[^>]*>(.*?)</,           // Generic XML-style text
            /message>(.*?)</              // Generic message content
        ];

        // Try each pattern
        let text = '';
        for (const pattern of patterns) {
            const match = content.match(pattern);
            if (match?.[1]) {
                text = match[1];
                if (text.length > 5) { // Only use if we got something substantial
                    break;
                }
            }
        }

        // Look for URLs
        const urlPatterns = [
            /(https?:\/\/[^\s<"]+)/,      // Standard URLs
            /NSString">(https?:\/\/[^\s<"]+)/, // URLs in NSString
            /"url":\s*"(https?:\/\/[^"]+)"/, // URLs in JSON format
            /link[^>]*>(https?:\/\/[^<]+)/ // URLs in XML-style tags
        ];

        let url: string | undefined;
        for (const pattern of urlPatterns) {
            const match = content.match(pattern);
            if (match?.[1]) {
                url = match[1];
                break;
            }
        }

        if (!text && !url) {
            // Try to extract any readable text content
            const readableText = content
                .replace(/streamtyped.*?NSString/g, '') // Remove streamtyped header
                .replace(/NSAttributedString.*?NSString/g, '') // Remove attributed string metadata
                .replace(/NSDictionary.*?$/g, '') // Remove dictionary metadata
                .replace(/\+[A-Za-z]+\s/g, '') // Remove +[identifier] patterns
                .replace(/NSNumber.*?NSValue.*?\*/g, '') // Remove number/value metadata
                .replace(/[^\x20-\x7E]/g, ' ') // Replace non-printable chars with space
                .replace(/\s+/g, ' ')          // Normalize whitespace
                .trim();

            if (readableText.length > 5) {    // Only use if we got something substantial
                text = readableText;
            } else {
                return { text: '[Message content not readable]' };
            }
        }

        // Clean up the found text
        if (text) {
            text = text
                .replace(/^[+\s]+/, '') // Remove leading + and spaces
                .replace(/\s*iI\s*[A-Z]\s*$/, '') // Remove iI K pattern at end
                .replace(/\s+/g, ' ') // Normalize whitespace
                .trim();
        }

        return { text: text || url || '', url };
    } catch (error) {
        console.error('Error decoding attributedBody:', error);
        return { text: '[Message content not readable]' };
    }
}

async function getAttachmentPaths(messageId: number): Promise<string[]> {
    try {
        const query = `
            SELECT filename
            FROM attachment
            INNER JOIN message_attachment_join
            ON attachment.ROWID = message_attachment_join.attachment_id
            WHERE message_attachment_join.message_id = ${messageId}
        `;

        const { stdout } = await executeSQLite(query);

        if (!stdout.trim()) {
            return [];
        }

        const attachments = JSON.parse(stdout) as { filename: string }[];
        return attachments.map(a => a.filename).filter(Boolean);
    } catch (error) {
        console.error('Error getting attachments:', error);
        return [];
    }
}

async function readMessages(phoneNumber: string, limit = 10): Promise<Message[]> {
    try {
        // Enforce maximum limit for performance
        const maxLimit = Math.min(limit, CONFIG.MAX_MESSAGES);

        // Check access and get instructions if needed
        const accessResult = await requestMessagesAccess();
        if (!accessResult.hasAccess) {
            throw new Error(accessResult.message);
        }

        // Get all possible formats of the phone number
        const phoneFormats = normalizePhoneNumber(phoneNumber);


        // Create SQL IN clause with all phone number formats
        const phoneList = phoneFormats.map(p => `'${p.replace(/'/g, "''")}'`).join(',');

        const query = `
            SELECT
                m.ROWID as message_id,
                CASE
                    WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
                    WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
                    ELSE NULL
                END as content,
                strftime('%Y-%m-%dT%H:%M:%fZ', m.date/1000000000.0 + 978307200, 'unixepoch') as date,
                h.id as sender,
                m.is_from_me,
                m.is_audio_message,
                m.cache_has_attachments,
                m.subject,
                CASE
                    WHEN m.text IS NOT NULL AND m.text != '' THEN 0
                    WHEN m.attributedBody IS NOT NULL THEN 1
                    ELSE 2
                END as content_type
            FROM message m
            INNER JOIN handle h ON h.ROWID = m.handle_id
            WHERE h.id IN (${phoneList})
                AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
                AND m.is_from_me IS NOT NULL  -- Ensure it's a real message
                AND m.item_type = 0  -- Regular messages only
                AND m.is_audio_message = 0  -- Skip audio messages
            ORDER BY m.date DESC
            LIMIT ${maxLimit}
        `;

        // Execute query with retries
        const { stdout } = await retryOperation(() =>
            executeSQLite(query)
        );

        if (!stdout.trim()) {
            console.error("No messages found in database for the given phone number");
            return [];
        }

        const messages = JSON.parse(stdout) as (Message & {
            message_id: number;
            is_audio_message: number;
            cache_has_attachments: number;
            subject: string | null;
            content_type: number;
        })[];

        // Process messages with potential parallel attachment fetching
        const processedMessages = await Promise.all(
            messages
                .filter(msg => msg.content !== null || msg.cache_has_attachments === 1)
                .map(async msg => {
                    let content = msg.content || '';
                    let url: string | undefined;

                    // If it's an attributedBody (content_type = 1), decode it
                    if (msg.content_type === 1) {
                        const decoded = decodeAttributedBody(content);
                        content = decoded.text;
                        url = decoded.url;
                    } else {
                        // Check for URLs in regular text messages
                        const urlMatch = content.match(/(https?:\/\/[^\s]+)/);
                        if (urlMatch) {
                            url = urlMatch[1];
                        }
                    }

                    // Get attachments if any
                    let attachments: string[] = [];
                    if (msg.cache_has_attachments) {
                        attachments = await getAttachmentPaths(msg.message_id);
                    }

                    // Add subject if present
                    if (msg.subject) {
                        content = `Subject: ${msg.subject}\n${content}`;
                    }

                    // Format the message object
                    const formattedMsg: Message = {
                        content: content || '[No text content]',
                        date: new Date(msg.date).toISOString(),
                        sender: msg.sender,
                        is_from_me: Boolean(msg.is_from_me)
                    };

                    // Add attachments if any
                    if (attachments.length > 0) {
                        formattedMsg.attachments = attachments;
                        formattedMsg.content += `\n[Attachments: ${attachments.length}]`;
                    }

                    // Add URL if present
                    if (url) {
                        formattedMsg.url = url;
                        formattedMsg.content += `\n[URL: ${url}]`;
                    }

                    return formattedMsg;
                })
        );

        return processedMessages;
    } catch (error) {
        console.error('Error reading messages:', error);
        if (error instanceof Error) {
            console.error('Error details:', error.message);
            console.error('Stack trace:', error.stack);
        }
        throw new Error('Messages history read failed: ' + (error instanceof Error ? error.message : String(error)));
    }
}

async function getUnreadMessages(limit = 10): Promise<Message[]> {
    try {
        // Enforce maximum limit for performance
        const maxLimit = Math.min(limit, CONFIG.MAX_MESSAGES);

        // Check access and get instructions if needed
        const accessResult = await requestMessagesAccess();
        if (!accessResult.hasAccess) {
            throw new Error(accessResult.message);
        }

        const query = `
            SELECT
                m.ROWID as message_id,
                CASE
                    WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
                    WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
                    ELSE NULL
                END as content,
                strftime('%Y-%m-%dT%H:%M:%fZ', m.date/1000000000.0 + 978307200, 'unixepoch') as date,
                h.id as sender,
                m.is_from_me,
                m.is_audio_message,
                m.cache_has_attachments,
                m.subject,
                CASE
                    WHEN m.text IS NOT NULL AND m.text != '' THEN 0
                    WHEN m.attributedBody IS NOT NULL THEN 1
                    ELSE 2
                END as content_type
            FROM message m
            INNER JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.is_from_me = 0  -- Only messages from others
                AND m.is_read = 0   -- Only unread messages
                AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
                AND m.is_audio_message = 0  -- Skip audio messages
                AND m.item_type = 0  -- Regular messages only
            ORDER BY m.date DESC
            LIMIT ${maxLimit}
        `;

        // Execute query with retries
        const { stdout } = await retryOperation(() =>
            executeSQLite(query)
        );

        if (!stdout.trim()) {
            console.error("No unread messages found");
            return [];
        }

        const messages = JSON.parse(stdout) as (Message & {
            message_id: number;
            is_audio_message: number;
            cache_has_attachments: number;
            subject: string | null;
            content_type: number;
        })[];

        // Process messages with potential parallel attachment fetching
        const processedMessages = await Promise.all(
            messages
                .filter(msg => msg.content !== null || msg.cache_has_attachments === 1)
                .map(async msg => {
                    let content = msg.content || '';
                    let url: string | undefined;

                    // If it's an attributedBody (content_type = 1), decode it
                    if (msg.content_type === 1) {
                        const decoded = decodeAttributedBody(content);
                        content = decoded.text;
                        url = decoded.url;
                    } else {
                        // Check for URLs in regular text messages
                        const urlMatch = content.match(/(https?:\/\/[^\s]+)/);
                        if (urlMatch) {
                            url = urlMatch[1];
                        }
                    }

                    // Get attachments if any
                    let attachments: string[] = [];
                    if (msg.cache_has_attachments) {
                        attachments = await getAttachmentPaths(msg.message_id);
                    }

                    // Add subject if present
                    if (msg.subject) {
                        content = `Subject: ${msg.subject}\n${content}`;
                    }

                    // Format the message object
                    const formattedMsg: Message = {
                        content: content || '[No text content]',
                        date: new Date(msg.date).toISOString(),
                        sender: msg.sender,
                        is_from_me: Boolean(msg.is_from_me)
                    };

                    // Add attachments if any
                    if (attachments.length > 0) {
                        formattedMsg.attachments = attachments;
                        formattedMsg.content += `\n[Attachments: ${attachments.length}]`;
                    }

                    // Add URL if present
                    if (url) {
                        formattedMsg.url = url;
                        formattedMsg.content += `\n[URL: ${url}]`;
                    }

                    return formattedMsg;
                })
        );

        return processedMessages;
    } catch (error) {
        console.error('Error reading unread messages:', error);
        if (error instanceof Error) {
            console.error('Error details:', error.message);
            console.error('Stack trace:', error.stack);
        }
        throw new Error('Messages unread read failed: ' + (error instanceof Error ? error.message : String(error)));
    }
}

const scheduledMessages=new Map<string,ReturnType<typeof setTimeout>>();
async function scheduleMessage(phoneNumber:string,message:string,scheduledTime:Date) {
  normalizePhoneNumber(phoneNumber);
  if(!message.trim()) throw new Error('Message is required');
  const delay=scheduledTime.getTime()-Date.now();
  if(!Number.isFinite(delay) || delay<=0) throw new Error('Schedule time must be in the future');
  // Node clamps longer timers to 1ms. Reject instead of accidentally sending immediately.
  if(delay>2147483647) throw new Error('Schedule exceeds maximum process timer range (24.8 days)');
  const id=randomUUID();
  const timer=setTimeout(async()=>{
    try{await sendMessage(phoneNumber,message);}
    catch(error){console.error('Scheduled send failed:',error instanceof Error?error.message:'Unknown error');}
    finally{scheduledMessages.delete(id);}
  },delay);
  scheduledMessages.set(id,timer);
  return {id,scheduledTime,phoneNumber,message,status:'scheduled',
    persistence:'process',warning:'Keep this MCP server process running until send time. Exiting or restarting cancels this schedule; receipt is unconfirmed.'};
}

/**
 * AppleScript fallback for reading messages (simplified, limited functionality)
 */
async function readMessagesAppleScript(phoneNumber: string, limit: number): Promise<Message[]> {
    try {
        const script = `
tell application "Messages"
    return "SUCCESS:messages_not_accessible_via_applescript"
end tell`;

        const result = await runAppleScript(script) as string;

        if (result && result.includes('SUCCESS')) {
            // Return empty array with a note that AppleScript doesn't provide full message access
            return [];
        }

        return [];
    } catch (error) {
        console.error(`AppleScript fallback failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

/**
 * AppleScript fallback for getting unread messages (simplified, limited functionality)
 */
async function getUnreadMessagesAppleScript(limit: number): Promise<Message[]> {
    try {
        const script = `
tell application "Messages"
    return "SUCCESS:unread_messages_not_accessible_via_applescript"
end tell`;

        const result = await runAppleScript(script) as string;

        if (result && result.includes('SUCCESS')) {
            // Return empty array with a note that AppleScript doesn't provide full message access
            return [];
        }

        return [];
    } catch (error) {
        console.error(`AppleScript fallback failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

export default { sendMessage, readMessages, scheduleMessage, getUnreadMessages, requestMessagesAccess };
