#!/usr/bin/env node
/**
 * lark-cli-mcp — a minimal, dependency-free MCP server that turns `lark-cli`
 * plus its bundled skills into MCP tools.
 *
 * Design: instead of hand-coding hundreds of structured tools (one per
 * lark-cli command), we expose a small "gateway" that mirrors how the skills
 * are meant to be used:
 *   1. lark_list_skills  — discover which lark-* skills exist
 *   2. lark_read_skill   — read a skill's SKILL.md / reference docs to learn usage
 *   3. lark_run          — execute any lark-cli command (argv array, no shell)
 * plus two convenience wrappers (lark_send_message, lark_list_chats).
 *
 * This covers the full capability surface of every lark-* skill.
 *
 * Transport: stdio, JSON-RPC 2.0 (MCP). No external dependencies.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LARK_CLI = process.env.LARK_CLI_BIN || 'lark-cli';
const SKILLS_DIR = process.env.LARK_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'lark-cli-mcp', version: '0.2.0' };

// Clean JSON output from lark-cli (suppress notifier noise)
const CLI_ENV = Object.assign({}, process.env, {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
});

// ---------- tool definitions ----------
const TOOLS = [
  {
    name: 'lark_list_skills',
    description:
      'List all available lark-* skills (Feishu/Lark capability domains: im, calendar, drive, doc, sheets, base, task, mail, vc, wiki, contact, etc.) with their descriptions. Call this first to discover which skill covers your task, then use lark_read_skill to learn the exact commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lark_read_skill',
    description:
      'Read a lark-* skill document to learn the correct lark-cli commands, flags, identity rules and safety notes before running them. Pass a skill name (e.g. "lark-im") to read its SKILL.md, or a relative doc path (e.g. "lark-im/references/lark-im-messages-send.md") to read a referenced file. ALWAYS read the relevant skill before using lark_run for a non-trivial command.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name (e.g. "lark-im") for its SKILL.md, or a relative path under the skills dir (e.g. "lark-im/references/lark-im-messages-send.md").',
        },
      },
      required: ['skill'],
    },
  },
  {
    name: 'lark_run',
    description:
      'Execute an arbitrary lark-cli command. Provide args as an array of strings (argv), e.g. ["im","+messages-send","--as","user","--user-id","ou_xxx","--text","hi"]. No shell is used, so no quoting/escaping is needed. Returns stdout, stderr and exit code. IMPORTANT: read the relevant skill via lark_read_skill first to get the exact command shape. High-risk writes exit with code 10 and a confirmation_required envelope — surface it to the user and only retry with "--yes" appended after explicit user consent.',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'lark-cli arguments as an argv array (do NOT include the leading "lark-cli").',
        },
        stdin: {
          type: 'string',
          description: 'Optional data to pipe to the command stdin (useful for @file/large JSON inputs).',
        },
      },
      required: ['args'],
    },
  },
  {
    name: 'lark_send_message',
    description:
      'Convenience: send a Feishu/Lark message via lark-cli. identity="user" (default) sends as the authenticated person; identity="bot" sends as the app. Recipient "to" is a user open_id (ou_...) or a chat_id (oc_...).',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient: user open_id ("ou_...") or chat_id ("oc_...").' },
        to_type: { type: 'string', enum: ['auto', 'open_id', 'chat_id'], description: 'Default "auto": infer from prefix.' },
        text: { type: 'string', description: 'Plain-text content (exclusive with markdown).' },
        markdown: { type: 'string', description: 'Markdown content (exclusive with text).' },
        identity: { type: 'string', enum: ['user', 'bot'], description: 'Default "user".' },
      },
      required: ['to'],
    },
  },
  {
    name: 'lark_list_chats',
    description: 'Convenience: list Feishu/Lark group chats the current user/bot belongs to (to discover a chat_id).',
    inputSchema: {
      type: 'object',
      properties: {
        identity: { type: 'string', enum: ['user', 'bot'], description: 'Default "user".' },
        query: { type: 'string', description: 'Optional keyword to filter chats by name.' },
      },
    },
  },
];

// ---------- helpers ----------
function runLarkCli(args, stdin) {
  return new Promise((resolve) => {
    const child = execFile(LARK_CLI, args, { env: CLI_ENV, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), err, stdout: stdout || '', stderr: stderr || '' });
    });
    if (stdin != null) {
      try { child.stdin.write(stdin); child.stdin.end(); } catch (_) {}
    }
  });
}

function tryParseJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// Safely resolve a requested skill path within SKILLS_DIR (block traversal)
function resolveSkillPath(input) {
  let rel = String(input || '').trim();
  if (!rel) throw new Error('`skill` is required');
  // bare skill name -> its SKILL.md
  if (!rel.includes('/')) rel = path.join(rel, 'SKILL.md');
  const full = path.resolve(SKILLS_DIR, rel);
  const root = path.resolve(SKILLS_DIR) + path.sep;
  if (full !== path.resolve(SKILLS_DIR) && !full.startsWith(root)) {
    throw new Error('Path escapes skills directory: ' + input);
  }
  return full;
}

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) throw new Error('Skills dir not found: ' + SKILLS_DIR);
  const entries = fs.readdirSync(SKILLS_DIR)
    .filter((name) => {
      if (!name.startsWith('lark')) return false;
      try {
        // follow symlinks; skill dirs under ~/.claude/skills are symlinked
        return fs.statSync(path.join(SKILLS_DIR, name)).isDirectory();
      } catch (_) { return false; }
    })
    .sort();
  const skills = entries.map((name) => {
    const md = path.join(SKILLS_DIR, name, 'SKILL.md');
    let description = '';
    if (fs.existsSync(md)) {
      const head = fs.readFileSync(md, 'utf8').slice(0, 4000);
      const m = head.match(/description:\s*(.*)/);
      if (m) description = m[1].replace(/^["']|["']\s*$/g, '').trim();
    }
    return { skill: name, description };
  });
  return { skills_dir: SKILLS_DIR, count: skills.length, skills };
}

// ---------- tool impls ----------
async function toolListSkills() { return listSkills(); }

async function toolReadSkill(a) {
  const full = resolveSkillPath(a && a.skill);
  if (!fs.existsSync(full)) throw new Error('Not found: ' + full);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(full);
    return { path: full, type: 'directory', entries: files };
  }
  const content = fs.readFileSync(full, 'utf8');
  return { path: full, type: 'file', bytes: Buffer.byteLength(content), content };
}

async function toolRun(a) {
  if (!a || !Array.isArray(a.args)) throw new Error('`args` must be an array of strings');
  const args = a.args.map(String);
  const { code, stdout, stderr } = await runLarkCli(args, a.stdin);
  const parsed = tryParseJson(stdout);
  return {
    exit_code: code,
    ok: code === 0,
    // high-risk write gate surfaces as exit 10 + confirmation_required envelope on stderr
    confirmation_required: code === 10,
    stdout: parsed !== null ? undefined : stdout,
    json: parsed !== null ? parsed : undefined,
    stderr: stderr || undefined,
  };
}

async function toolSendMessage(a) {
  const to = ((a && a.to) || '').trim();
  if (!to) throw new Error('`to` is required');
  if (a.text && a.markdown) throw new Error('Provide only one of `text` or `markdown`');
  if (!a.text && !a.markdown) throw new Error('Provide `text` or `markdown`');
  let toType = a.to_type || 'auto';
  if (toType === 'auto') {
    if (to.startsWith('oc_')) toType = 'chat_id';
    else if (to.startsWith('ou_')) toType = 'open_id';
    else throw new Error('Cannot infer to_type from "' + to + '"; set to_type explicitly');
  }
  const identity = a.identity === 'bot' ? 'bot' : 'user';
  const args = ['im', '+messages-send', '--as', identity];
  args.push(toType === 'chat_id' ? '--chat-id' : '--user-id', to);
  if (a.markdown) args.push('--markdown', a.markdown);
  else args.push('--text', a.text);
  const { code, stdout, stderr } = await runLarkCli(args);
  const parsed = tryParseJson(stdout);
  if (code !== 0 && !parsed) throw new Error('lark-cli failed (exit ' + code + '): ' + (stderr || stdout));
  if (parsed && parsed.ok === false) throw new Error('lark-cli error: ' + stdout.trim());
  return parsed || { raw: stdout.trim() };
}

async function toolListChats(a) {
  const identity = (a && a.identity) === 'bot' ? 'bot' : 'user';
  const args = ['im', '+chat-list', '--as', identity];
  if (a && a.query) args.push('--query', a.query);
  const { code, stdout, stderr } = await runLarkCli(args);
  const parsed = tryParseJson(stdout);
  if (code !== 0 && !parsed) throw new Error('lark-cli failed (exit ' + code + '): ' + (stderr || stdout));
  return parsed || { raw: stdout.trim() };
}

async function dispatchTool(name, args) {
  switch (name) {
    case 'lark_list_skills': return await toolListSkills();
    case 'lark_read_skill': return await toolReadSkill(args || {});
    case 'lark_run': return await toolRun(args || {});
    case 'lark_send_message': return await toolSendMessage(args || {});
    case 'lark_list_chats': return await toolListChats(args || {});
    default: throw new Error('Unknown tool: ' + name);
  }
}

// ---------- JSON-RPC over stdio ----------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      if (!isNotification) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params && params.name;
      const args = params && params.arguments;
      try {
        const data = await dispatchTool(name, args);
        reply(id, { content: [{ type: 'text', text: JSON.stringify(data) }] });
      } catch (e) {
        reply(id, { content: [{ type: 'text', text: 'Error: ' + ((e && e.message) || String(e)) }], isError: true });
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, 'Method not found: ' + method);
      return;
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = tryParseJson(line);
    if (!msg) continue;
    handle(msg).catch((e) => {
      if (msg && msg.id != null) replyError(msg.id, -32603, 'Internal error: ' + ((e && e.message) || String(e)));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
