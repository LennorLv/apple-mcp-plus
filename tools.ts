import { type Tool } from "@modelcontextprotocol/sdk/types.js";

const CONTACTS_TOOL: Tool = {
    name: "contacts",
    description: "Search and retrieve contacts from Apple Contacts app",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name to search for (optional - if not provided, returns all contacts). Can be partial name to search."
        }
      }
    }
  };

  const NOTES_TOOL: Tool = {
    name: "notes",
    description: "Search, retrieve and create notes. todos reads locally saved native checklist states using the Notes database (requires Full Disk Access), plus plaintext task markers; unreadable states are reported explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "Operation to perform: 'search', 'list', 'todos', or 'create'",
          enum: ["search", "list", "todos", "create"]
        },
        limit: {type:"integer",minimum:1,maximum:100,description:"Maximum notes returned (default 50)"},
        sortBy: {type:"string",enum:["creationDate","modificationDate"],description:"Sort/date filter field; default modificationDate"},
        sortOrder: {type:"string",enum:["asc","desc"],description:"Default desc (newest first)"},
        fromDate: {type:"string",format:"date-time",description:"Inclusive start, ISO timestamp with timezone"},
        toDate: {type:"string",format:"date-time",description:"Exclusive end, ISO timestamp with timezone"},
        contentLimit: {type:"integer",minimum:1,maximum:100000,description:"Body preview characters per note, default 2000"},
        searchText: {
          type: "string",
          description: "Text to search for in notes (required for search operation)"
        },
        title: {
          type: "string",
          description: "Title of the note to create (required for create operation)"
        },
        body: {
          type: "string",
          description: "Content of the note to create (required for create operation)"
        },
        folderName: {
          type: "string",
          description: "Folder filter for reads; target folder for create (defaults to Claude)"
        }
      },
      required: ["operation"]
    }
  };

  const MESSAGES_TOOL: Tool = {
    name: "messages",
    description: "Interact with Apple Messages app - send, read, schedule messages and check unread messages",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "Operation to perform: 'send', 'read', 'schedule', or 'unread'",
          enum: ["send", "read", "schedule", "unread"]
        },
        phoneNumber: {
          type: "string",
          description: "Phone number to send message to (required for send, read, and schedule operations)"
        },
        message: {
          type: "string",
          description: "Message to send (required for send and schedule operations)"
        },
        limit: {
          type: "number",
          description: "Number of messages to read (1-100, for read and unread operations)"
        },
        scheduledTime: {
          type: "string",
          description: "ISO timestamp with timezone, within 24.8 days. MCP process must stay running; restart cancels the schedule."
        }
      },
      required: ["operation"]
    }
  };

  const MAIL_TOOL: Tool = {
    name: "mail",
    description: "Interact with Apple Mail app - read unread emails, search emails, and send emails",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "Operation to perform: 'unread', 'search', 'send', 'mailboxes', 'accounts', or 'latest'",
          enum: ["unread", "search", "send", "mailboxes", "accounts", "latest"]
        },
        account: {
          type: "string",
          description: "Email account to use (optional - if not provided, searches across all accounts)"
        },
        mailbox: {
          type: "string",
          description: "Mailbox name/path, inbox or all; default inbox for latest/unread, all for search"
        },
        limit: {
          type: "integer",minimum:1,maximum:100,
          description: "Number of emails to retrieve (optional, for unread, search, and latest operations)"
        },
        fromDate: {type:"string",format:"date-time",description:"Inclusive received-time start; ISO timestamp with timezone"},
        toDate: {type:"string",format:"date-time",description:"Exclusive received-time end; ISO timestamp with timezone"},
        searchIn: {type:"string",enum:["subject","all"],description:"Search subject (default), or subject and full body, newest first. Body scan is bounded to 100 non-subject matches/10 seconds; narrow mailbox/dates if budget is exceeded."},
        searchTerm: {
          type: "string",
          description: "Text to search for in emails (required for search operation)"
        },
        to: {
          type: "string",
          description: "Recipient email address (required for send operation)"
        },
        subject: {
          type: "string",
          description: "Email subject (required for send operation)"
        },
        body: {
          type: "string",
          description: "Email body content (required for send operation)"
        },
        cc: {
          type: "string",
          description: "CC email address (optional for send operation)"
        },
        bcc: {
          type: "string",
          description: "BCC email address (optional for send operation)"
        }
      },
      required: ["operation"]
    }
  };

  const REMINDERS_TOOL: Tool = {
    name: "reminders",
    description: "Search, create, and open reminders in Apple Reminders app",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "Operation to perform: 'list', 'search', 'open', 'create', or 'listById'",
          enum: ["list", "search", "open", "create", "listById"]
        },
        completed: {type:"boolean",description:"Filter actual completion status; false returns unfinished reminders"},
        limit: {type:"integer",minimum:1,maximum:100,description:"Maximum reminders returned, default 50"},
        searchText: {
          type: "string",
          description: "Text to search for in reminders (required for search and open operations)"
        },
        name: {
          type: "string",
          description: "Name of the reminder to create (required for create operation)"
        },
        listName: {
          type: "string",
          description: "List filter for reads, or target list for create"
        },
        listId: {
          type: "string",
          description: "ID of the list to get reminders from (required for listById operation)"
        },
        props: {
          type: "array",
          items: {
            type: "string"
          },
          description: "Properties to include in the reminders (optional for listById operation)"
        },
        notes: {
          type: "string",
          description: "Additional notes for the reminder (optional for create operation)"
        },
        dueDate: {
          type: "string",
          description: "Due date for the reminder in ISO format (optional for create operation)"
        }
      },
      required: ["operation"]
    }
  };


const CALENDAR_TOOL: Tool = {
  name: "calendar",
  description: "Search, create, and open calendar events in Apple Calendar app",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform: 'search', 'open', 'list', or 'create'",
        enum: ["search", "open", "list", "create"]
      },
      searchText: {
        type: "string",
        description: "Text to search for in event titles, locations, and notes (required for search operation)"
      },
      eventId: {
        type: "string",
        description: "ID of the event to open (required for open operation)"
      },
      limit: {
        type: "number",
        description: "Number of events to retrieve (optional, default 10)"
      },
      fromDate: {
        type: "string",
        description: "Start date for search range in ISO format (optional, default is today)"
      },
      toDate: {
        type: "string",
        description: "End date for search range in ISO format (optional, default is 30 days from now for search, 7 days for list)"
      },
      title: {
        type: "string",
        description: "Title of the event to create (required for create operation)"
      },
      startDate: {
        type: "string",
        description: "Start date/time of the event in ISO format (required for create operation)"
      },
      endDate: {
        type: "string",
        description: "End date/time of the event in ISO format (required for create operation)"
      },
      location: {
        type: "string",
        description: "Location of the event (optional for create operation)"
      },
      notes: {
        type: "string",
        description: "Additional notes for the event (optional for create operation)"
      },
      isAllDay: {
        type: "boolean",
        description: "Whether the event is an all-day event (optional for create operation, default is false)"
      },
      calendarName: {
        type: "string",
        description: "Name of the calendar to create the event in (optional for create operation, uses default calendar if not specified)"
      }
    },
    required: ["operation"]
  }
};

const tools = [CONTACTS_TOOL, NOTES_TOOL, MESSAGES_TOOL, MAIL_TOOL, REMINDERS_TOOL, CALENDAR_TOOL];

// Diagnostics are shared across tools and never request permissions.
for (const tool of tools) {
  const properties = tool.inputSchema.properties as Record<string, any>;
  const operation = properties.operation || {type:"string",enum:[]};
  properties.operation = {...operation,enum:[...operation.enum,"status","diagnose"],
    description:(operation.description || "Optional operation") + "; status/diagnose inspect effective permissions without prompts"};
}
for (const tool of [REMINDERS_TOOL,CALENDAR_TOOL]) {
  const properties=tool.inputSchema.properties as Record<string,any>;
  properties.backend={type:"string",enum:["jxa","eventkit"],description:"Existing list/search defaults to jxa. EventKit is an explicit read pilot; IDs differ. New native-only operations default to eventkit. Writes/open remain jxa."};
  properties.operation.enum.push("authorize",...(tool===REMINDERS_TOOL?["lists"]:["calendars","getById"]));
  properties.operation.description += "; authorize explicitly requests EventKit full access; lists/calendars return exact native container IDs; calendar getById reads an exact EventKit event";
}
const calendarProperties=CALENDAR_TOOL.inputSchema.properties as Record<string,any>;
calendarProperties.calendarId={type:"string",description:"Exact EventKit calendar ID for reads; requires backend eventkit"};
calendarProperties.calendarIds={type:"array",items:{type:"string"},minItems:1,description:"Exact EventKit calendar IDs; mutually exclusive with calendarId"};
calendarProperties.occurrenceDate={type:"string",format:"date-time",description:"Exact occurrence timestamp, required for recurring getById"};
calendarProperties.calendarName.description="Exact calendar name for reads/create; duplicate names are rejected";
calendarProperties.eventId.description="Calendar UID for open; EventKit event ID for getById. Do not interchange these IDs.";

export default tools;
