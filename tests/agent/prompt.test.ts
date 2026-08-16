import { describe, it, expect } from "vitest";
import { buildSystemPrompt, formatRecentConversations } from "../../src/agent/prompt.js";

describe("prompt builders", () => {
  it("system prompt mentions the owner", () => {
    expect(buildSystemPrompt("alice")).toContain("alice");
  });

  it("formats empty conversations clearly", () => {
    expect(formatRecentConversations([])).toMatch(/no prior/i);
  });

  it("formats rows in given order", () => {
    const out = formatRecentConversations([
      { id: 1, ts: 0, speaker: "alice", text: "hi", channel: "chat" },
      { id: 2, ts: 1000, speaker: "bot", text: "hello", channel: "chat" },
    ]);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toMatch(/alice: hi/);
  });

  it("system prompt advertises movement tools", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/gotoCoords/);
    expect(prompt).toMatch(/gotoPlayer/);
  });

  it("routes requester-relative movement and shelter missions without duplicates", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/come to me.*gotoPlayer/i);
    expect(prompt).toMatch(/follow me.*followPlayer/i);
    expect(prompt).toMatch(/build a house\/shelter here/i);
    expect(prompt).toMatch(/oak_field_shelter/);
    expect(prompt).toMatch(/never create a second matching/i);
  });

  it("system prompt advertises memory tools", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/rememberFact/);
    expect(prompt).toMatch(/rememberLocation/);
    expect(prompt).toMatch(/recall/);
    expect(prompt).toMatch(/setGoal/);
    expect(prompt).toMatch(/returnToBase/);
  });

  it("system prompt advertises runCommand and the privacy guarantee", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/runCommand/);
    expect(prompt).toMatch(/private whisper|private reply/i);
    expect(prompt).toMatch(/alice/);
  });

  it("system prompt establishes the lowercase chat-shorthand style", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/lowercase/i);
    expect(prompt).toMatch(/wya|rn|idk|ngl/);
  });

  it("system prompt distinguishes sayPublic from say", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/sayPublic/);
    expect(prompt).toMatch(/say in chat|tell everyone|announce/i);
  });

  it("system prompt advertises inspect and tells the model to call it before coord-using tools", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/inspect/);
    expect(prompt).toMatch(/before.*gotoCoords|before.*rememberLocation/i);
  });

  it("system prompt mentions the reactive layer and tells Claude not to manage HP/food/combat", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/reactive|reflex/i);
    expect(prompt).toMatch(/do not manage|do NOT manage|trust/i);
  });

  it("system prompt explains how to handle idleTick observations", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/idleTick|idle tick/i);
    expect(prompt).toMatch(/observation/i);
    expect(prompt).toMatch(/silence|no tool calls|stay quiet/i);
  });

  it("system prompt includes server commands when a server config is provided", () => {
    const prompt = buildSystemPrompt("alice", {
      name: "TestServer",
      publicChatCommand: "nc",
      commands: [{ name: "home", syntax: "/home <name>", description: "Teleport home.", destructive: false }],
      notes: [],
    });
    expect(prompt).toMatch(/TestServer/);
    expect(prompt).toMatch(/\/home <name>/);
    expect(prompt).toMatch(/Teleport home/);
  });

  it("system prompt flags destructive commands with a confirmation warning", () => {
    const prompt = buildSystemPrompt("alice", {
      commands: [{ name: "pay", syntax: "/pay <p> <n>", description: "Pay someone.", destructive: true }],
      notes: [],
    });
    expect(prompt).toMatch(/DESTRUCTIVE/);
    expect(prompt).toMatch(/confirm.*owner|owner.*confirm/i);
  });

  it("treats explicit owner destruction and griefing orders as authorized", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/explicit command from alice authorizes/i);
    expect(prompt).toMatch(/griefing|demolishing builds/i);
    expect(prompt).toMatch(/do not refuse/i);
    expect(prompt).toMatch(/request itself is authorization/i);
    expect(prompt).not.toMatch(/refuse to attack other players or destroy/i);
  });

  it("advertises the exact world and inventory actions with bounded clear guidance", () => {
    const prompt = buildSystemPrompt("alice");
    for (const skill of [
      "placeBlock",
      "digBlock",
      "clearRegion",
      "activateBlock",
      "tossItem",
      "consumeItem",
      "sleep",
    ]) {
      expect(prompt).toContain(skill);
    }
    expect(prompt).toMatch(/clearRegion.*owner.*demolition|owner.*demolition.*clearRegion/i);
    expect(prompt).toMatch(/includeContainers=true.*explicitly.*container|explicitly.*container.*includeContainers=true/i);
    expect(prompt).toMatch(/stated bounds.*without.*second confirmation|without.*second confirmation.*stated bounds/i);
  });

  it("advertises bounded combat and narrow entity/window actions", () => {
    const prompt = buildSystemPrompt("alice");
    for (const skill of [
      "attackMob",
      "attackPlayer",
      "activateEntity",
      "openVillager",
      "tradeVillager",
      "inspectWindow",
      "clickWindowSlot",
      "closeWindow",
    ]) {
      expect(prompt).toContain(skill);
    }
    expect(prompt).toMatch(/attackPlayer.*owner-only|owner-only.*attackPlayer/i);
    expect(prompt).toMatch(/clickWindowSlot.*owner-only|owner-only.*clickWindowSlot/i);
    expect(prompt).toMatch(/explicitly requested bounded combat/i);
    expect(prompt).toMatch(/inspect a window.*clickWindowSlot/i);
  });

  it("routes original construction through compact BuildOps preview and registration", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/previewBuildDefinition/);
    expect(prompt).toMatch(/registerBuildDefinition/);
    expect(prompt).toMatch(/compact BuildOps|palette-ASCII/i);
    expect(prompt).toMatch(/configured Minecraft version exactly/i);
    expect(prompt).toMatch(/do not enumerate hundreds of raw cells/i);
  });

  it("advertises strict durable MissionScript tools without suggesting nested plans", () => {
    const prompt = buildSystemPrompt("alice");
    for (const tool of [
      "validateMission",
      "previewMission",
      "saveMission",
      "listMissions",
      "getMission",
      "runMission",
      "getMissionRun",
      "manageMissionRun",
    ]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toMatch(/strict JSON-only ordered work/i);
    expect(prompt).toMatch(/one durable plan/i);
    expect(prompt).toMatch(/never create nested task plans/i);
  });

  it("teaches atomic actions, owner-only destructive work, and best-effort undo", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/atomic exact actions/i);
    expect(prompt).toMatch(/buildops.*raw cell enumeration/i);
    expect(prompt).toMatch(/missionScript.*survive restart/i);
    expect(prompt).toMatch(/clearRegion.*attackPlayer.*owner-only|attackPlayer.*clearRegion.*owner-only/i);
    expect(prompt).toMatch(/never turn a minecraft action into executable javascript python shell/i);
    expect(prompt).toMatch(/previewUndoTransaction/);
    expect(prompt).toMatch(/best-effort/i);
  });

  it("system prompt includes server notes when provided", () => {
    const prompt = buildSystemPrompt("alice", {
      commands: [],
      notes: ["Whispers use the [player -> me] format on this server."],
    });
    expect(prompt).toMatch(/Whispers use the \[player -> me\]/);
  });

  it("system prompt is unchanged when no server config is provided", () => {
    const before = buildSystemPrompt("alice");
    expect(before).not.toMatch(/Server-specific|This server has these/);
  });

  it("system prompt advertises the resource skills", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/mineUntil/);
    expect(prompt).toMatch(/chopTrees/);
    expect(prompt).toMatch(/pickupNearby/);
    expect(prompt).toMatch(/chestDeposit/);
  });

  it("system prompt mentions flight and the setFlight tool", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/setFlight/);
    expect(prompt).toMatch(/flight|fly/i);
  });

  it("system prompt explains long-running skill behavior and the stop tool", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/long-running|started immediately/i);
    expect(prompt).toMatch(/stop.*tool|call.*stop/i);
  });

  it("system prompt advertises inventory and findBlock and marks them on-demand", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/inventory/);
    expect(prompt).toMatch(/findBlock/);
    expect(prompt).toMatch(/on-demand|on demand|preemptive/i);
  });

  it("system prompt explains the detail flag and instructs Claude to default to false (terse)", () => {
    const prompt = buildSystemPrompt("alice");
    expect(prompt).toMatch(/detail/i);
    expect(prompt).toMatch(/terse|summary/i);
    expect(prompt).toMatch(/default.*false|false.*default/i);
  });
});
