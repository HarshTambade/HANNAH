import { describe, expect, it } from "vitest";
import { MAX_TOOLS_PER_REQUEST, selectToolsForRequest } from "../services/AgentRouter";
import type { HANNAHTool } from "../services/DeviceTools";

// The 44 tools the signed-in desktop app offers.
const names = "list_app_files,read_app_file,write_app_file,delete_app_file,open_app,make_call,toggle_setting,send_message,get_device_status,get_battery_status,create_reminder,list_reminders,cancel_reminder,search_memories,save_memory,knowledge_search,knowledge_documents,daily_briefing,create_workflow_draft,list_workflows,phone_find_contact,phone_call,phone_text,desktop_folders,desktop_list_files,desktop_read_file,desktop_write_file,desktop_run_command,desktop_look_at_screen,desktop_list_apps,desktop_open_app,desktop_startup_routine,desktop_set_startup_routine,browser_search,browser_open,browser_read,browser_scroll,browser_click,browser_type,browser_back,browser_look,youtube_read_video,browser_close,desktop_save_notes_pdf,email_search,email_read,calendar_events".split(",");
const all = names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, execute: async () => null }) as HANNAHTool);
const pick = (request: string, preferred: string[] = []) => selectToolsForRequest(all, request, { preferred: all.filter((tool) => preferred.includes(tool.name)) }).map((tool) => tool.name);

// The web version: no desktop tools, but web search and page reading, plus two connectors.
const webNames = "list_app_files,read_app_file,create_reminder,list_reminders,cancel_reminder,search_memories,save_memory,knowledge_search,knowledge_documents,daily_briefing,create_workflow_draft,list_workflows,web_search,web_read,email_search,email_read,calendar_events,mcp_c_linear_create_issue,mcp_c_linear_list_issues,mcp_c_notion_search,mcp_c_notion_create_page,mcp_c_stripe_list_customers,mcp_c_stripe_create_invoice,make_call,send_message".split(",");
const web = webNames.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, execute: async () => null }) as HANNAHTool);
const pickWeb = (request: string) => selectToolsForRequest(web, request).map((tool) => tool.name);

describe("web search and connectors", () => {
  it("offers web search for searches and recent things, and keeps it even when trimming", () => {
    for (const request of ["search for the latest Node.js release", "what's the current price of bitcoin", "who won the match today", "look this up for me"]) {
      expect(pickWeb(request), request).toEqual(expect.arrayContaining(["web_search", "web_read"]));
    }
    expect(pickWeb("call Aman and remind me tomorrow")).toContain("web_search");
  });

  it("brings a connector's tools when the request names it", () => {
    const picked = pickWeb("create an issue in Linear for the login bug and remind me tomorrow");
    expect(picked).toEqual(expect.arrayContaining(["mcp_c_linear_create_issue", "mcp_c_linear_list_issues"]));
    expect(picked).not.toContain("mcp_c_stripe_create_invoice");
  });
});

describe("choosing tools for a request", () => {
  it("never sends more than the server accepts", () => {
    for (const request of ["hi", "Find a GATE lecture on YouTube, make PDF notes and remind me tomorrow", "open my project in vs code, run the tests and email the results", "call Aman"]) {
      expect(pick(request).length).toBeLessThanOrEqual(MAX_TOOLS_PER_REQUEST);
    }
  });

  it("gives each request the tools it calls for", () => {
    expect(pick("Find a GATE operating systems lecture on YouTube and prepare PDF notes")).toEqual(expect.arrayContaining(["browser_search", "youtube_read_video", "desktop_save_notes_pdf"]));
    expect(pick("Hey HANNAH, call Aman using my phone")).toEqual(expect.arrayContaining(["phone_find_contact", "phone_call"]));
    expect(pick("Hey HANNAH, call Aman using my phone")).not.toContain("browser_search");
    expect(pick("Look at my screen and explain this error")).toContain("desktop_look_at_screen");
    expect(pick("Open VS Code with my project")).toEqual(expect.arrayContaining(["desktop_open_app", "desktop_folders"]));
    expect(pick("Open VS Code whenever I start my laptop")).toEqual(expect.arrayContaining(["desktop_set_startup_routine", "desktop_open_app"]));
    expect(pick("Check my Gmail and summarize important emails")).toEqual(expect.arrayContaining(["email_search", "email_read"]));
  });

  it("keeps the profile's own tools and a few core ones", () => {
    expect(pick("research the latest on this", ["knowledge_search"])).toEqual(expect.arrayContaining(["knowledge_search", "browser_search", "search_memories"]));
  });

  it("leaves a request that already fits unchanged when nothing specific is asked", () => {
    const few = all.slice(0, 12);
    expect(selectToolsForRequest(few, "hello there")).toBe(few);
  });
});
