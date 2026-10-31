"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { stopSpeaking } from "@/lib/mouth-drive";
import { cancelSpeech, primeVoices, speak } from "@/lib/speech";
import { reportError } from "@/lib/report-error";
import { beginStream, failStream, finishStream, recordChunk, recordMeta, recordProvider } from "@/lib/stream-telemetry";
import { AskDialog, ToastStack, type AskRequest, type Toast } from "@/app/components/Dialogs";
import { feedbackFor, feedbackToJsonl, loadFeedback, saveFeedback } from "@/lib/feedback";
import type { FreyaConfig } from "@/lib/freya-config";
import { PRIVATE_VOICE_DOWN } from "@/lib/intimacy";
import MarkdownContent from "@/app/components/MarkdownContent";
import VoiceNote, { type RecordedAudio } from "@/app/components/VoiceNote";
import VoiceRecorder from "@/app/components/VoiceRecorder";
import { speakable } from "@/lib/voice-playback";
import { prepareVoice } from "@/lib/voice-audio";
import AttachmentList from "@/app/components/Attachments";
import { AUDIO_MIMES, AttachmentError, MAX_ATTACHMENTS, type AttachmentKind, type AttachmentMeta, type WireAttachment } from "@/lib/attachments";
import { deleteAttachments, getAttachment, putAttachment } from "@/lib/attachment-store";
import { prepareAttachment } from "@/lib/prepare-attachment";
import { becomesLongForm, bubbleDelay, chopCasually, isAside, takeCompleteParts, wantsLongForm, busyDelay } from "@/lib/reply-parts";
import { addCuriosity, extractMoodTag, initialMood, loadMood, reactToMessage, resumeMood, saveMood, type MoodState } from "@/lib/mood";
import { contentWords } from "@/lib/stream-telemetry";
import { isReasoningMode, needsReasoning, type ReasoningMode } from "@/lib/reasoning-signal";
import LongformMessage from "@/app/components/LongformMessage";
import { describeThread, messagePreview, modelHistory, REACTIONS, referenceNote, requestTurns, turnOf, extractHerReaction } from "@/lib/chat-thread";
import { chaptersForPrompt, relationshipFacts, historyTotals } from "@/lib/chapters";
import { notificationPreview, notificationState, requestNotifications, showNotification } from "@/lib/notifications";
import { playChime } from "@/lib/chime";
import VoiceControls, { type SpeechRequest } from "@/app/components/VoiceControls";
import { CHARACTER_PROFILE_KEY, createDefaultCharacterProfile, normalizeCharacterProfile, type CharacterProfile } from "@/lib/character-profile";
import dynamic from "next/dynamic";
import type { CanvasForm, CanvasSignal } from "@/app/components/EmotionCanvas";
import { PictureCard, VisualizationCard, type PictureInfo, type VisualizationInfo } from "@/app/components/MediaCards";
import { commandHints, parseCommand, pictureRequest } from "@/lib/composer-commands";
import { FORM_POINTS, validateSpec, type VisualSpec } from "@/lib/visualize";
import { cloudForSpec } from "@/lib/visualize-client";
import { chooseExpression, reactionInReply, reactionTo, type Reaction } from "@/lib/expression";
import { sanitizeSvg } from "@/lib/svg-safety";
import { captureExplicitPreference } from "@/lib/memory-capture";
import { deriveReflectionCandidates } from "@/lib/reflection";
import { summarizeOlderMessages } from "@/lib/conversation-summary";
import { applyChangesLocally, describeChanges, LOCAL_MEMORY_LIMIT, loadForgotten, MEMORY_RESET_KEY, normalizeStoredMemories, reflectionWindow, rememberForgotten, type StoredMemory } from "@/lib/memory-client";
import type { MemoryChanges } from "@/lib/memory-reflection";
import { containsSensitiveCredential } from "@/lib/sensitive-data";

// Only rendered inside the settings dialog, so it stays out of the first-load bundle.
const CharacterProfileEditor = dynamic(() => import("@/app/components/CharacterProfileEditor"), { ssr: false });
const EmotionCanvas = dynamic(() => import("@/app/components/EmotionCanvas"), {
  ssr: false,
  loading: () => <section className="emotion-canvas canvas-loading" aria-label="Abstract FREYA visualization loading"><span>INITIALIZING ABSTRACT FIELD…</span></section>,
});
const PortraitParticles = dynamic(() => import("@/app/components/PortraitParticles"), {
  ssr: false,
  loading: () => <div className="portrait-particle-stage portrait-particle-loading" aria-label="Loading portrait particles">LOADING IMAGE PARTICLES…</div>,
});

type Source = { title: string; url: string };
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  provider?: string;
  /** FREYA's reply arrives as several messages; its parts share a turn id. */
  turn?: string;
  /** The user message a reply answers, shown as a tag when other messages came in between. */
  replyTo?: string;
  attachments?: AttachmentMeta[];
  /** ISO time the message was posted. */
  at?: string;
  /** Sent while FREYA was still answering something else; answered after that finishes. */
  queued?: boolean;
  /** A user voice note: the recording (in IndexedDB); `content` holds its transcript. */
  voice?: RecordedAudio;
  /** A FREYA message delivered as a voice note, spoken by the browser. */
  spoken?: boolean;
  /** A user message whose reply failed; it shows a Resend button. */
  failed?: boolean;
  /** A composed piece (essay, letter…) shown as one typed-out message. */
  longform?: boolean;
  /** Still being written; only meaningful while the reply runs. */
  streaming?: boolean;
  /** FREYA texted this first, unprompted. */
  initiative?: boolean;
  /** Cloud analysts who worked this reply through first (lib/council). */
  reasoned?: string[];
  /** A composer command (/visualize, /image, "draw me…") or a tagged refinement: shown as a chip, never sent as chat. */
  command?: "visualize" | "refine" | "image";
  /** The user's reaction to this message. */
  reaction?: string;
  /** Her reaction to this message of theirs; it may be her whole answer. */
  herReaction?: string;
  /** The user changed this message after sending it. */
  edited?: boolean;
  /** A /visualize result; its spec can be put back on the canvas. */
  visualization?: VisualizationInfo & { spec?: VisualSpec };
  /** A picture FREYA made: a generated image (in attachments) or an SVG drawing. */
  picture?: PictureInfo;
};
type Memory = StoredMemory;
type Conversation = {
  id: string; title: string; messages: Message[]; createdAt: string; updatedAt: string; unread?: number;
  /** How many of its messages automatic memory has already read, so nothing is mined twice. */
  reflectedCount?: number;
  /** Automatic memory's short note on this conversation, for FREYA to recall from other chats. */
  recap?: string;
};
/** One reply FREYA owes: to `targetId`, or a continuation of `turn` when `extraPrompt` is set. */
type ReplyJob = { conversationId: string; targetId: string; turn?: string; extraPrompt?: string; initiative?: boolean };
type Style = "adaptive" | "friendly" | "direct" | "professional" | "playful";
type PersonalityRevision = { revision: number; profile: CharacterProfile; summary: string; rollback_from: number | null; created_at: string };
type PersonalityProposal = { id: string; category: string; description: string; confidence: number; evidence: string[]; origin: string; status: string; created_at: string };

const MEMORY_KEY = "freya.v1.memories";
const CONVERSATIONS_KEY = "freya.v1.conversations";
const ACTIVE_CONVERSATION_KEY = "freya.v1.activeConversation";
const LEGACY_CHAT_KEY = "freya.v1.currentChat";
const MAX_CONVERSATIONS = 40;
const UNTITLED = "New subject";
const MAX_INPUT_CHARS = 6000;
const AUTONOMY_KEY = "freya.v1.autonomyLevel";
const PRIVACY_KEY = "freya.v1.localOnly";
const MODEL_KEY = "freya.v1.ollamaModel";
const AUTO_MEMORY_KEY = "freya.v1.autoMemory";
const MEMORY_ENABLED_KEY = "freya.v1.useMemories";
/** Quiet time after FREYA's last message before automatic memory reads the new stretch. */
const REFLECT_AFTER_MS = 90_000;
const CANDID_LANGUAGE_KEY = "freya.v1.candidLanguage";
const NOTIFICATIONS_KEY = "freya.v1.notifications";
const INITIATIVE_KEY = "freya.v1.initiative";
const SOUND_KEY = "freya.v1.messageSound";
const INTIMATE_KEY = "freya.v1.intimateMode";
const STAY_IN_CHARACTER_KEY = "freya.v1.stayInCharacter";
const REALISTIC_TIMING_KEY = "freya.v1.realisticTiming";
const REASONING_KEY = "freya.v1.reasoning";
/** Messages sent within this long of each other are answered together. */
const BURST_MS = 1500;
const NO_MESSAGES: Message[] = [];
const ATTACHMENT_KINDS = new Set<AttachmentKind>(["image", "pdf", "audio", "text", "file"]);
const supabase = getSupabaseBrowserClient();

function id() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function createConversation(): Conversation {
  const now = new Date().toISOString();
  return { id: id(), title: UNTITLED, messages: [], createdAt: now, updatedAt: now };
}

/** Conversations are named after their opening question, which is what people actually scan for. */
function deriveTitle(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return UNTITLED;
  return clean.length > 42 ? `${clean.slice(0, 42).trimEnd()}…` : clean;
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && (candidate.role === "user" || candidate.role === "assistant")
    && typeof candidate.content === "string";
}

function sanitizeAttachments(value: unknown): AttachmentMeta[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap((entry): AttachmentMeta[] => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
    const kind = ATTACHMENT_KINDS.has(candidate.kind as AttachmentKind) ? candidate.kind as AttachmentKind : "file";
    // Thumbnails are rendered as <img src>, so only the exact shape this app writes is kept.
    const thumb = typeof candidate.thumb === "string" && candidate.thumb.startsWith("data:image/jpeg;base64,") ? candidate.thumb : undefined;
    return [{
      id: candidate.id,
      name: candidate.name.slice(0, 160),
      mime: typeof candidate.mime === "string" ? candidate.mime.slice(0, 100) : "",
      size: typeof candidate.size === "number" && Number.isFinite(candidate.size) ? candidate.size : 0,
      kind,
      ...(thumb ? { thumb } : {}),
    }];
  }).slice(0, MAX_ATTACHMENTS);
  return items.length ? items : undefined;
}

/** Keeps only known fields. A queue does not survive a reload, so `queued` is dropped. */
function sanitizeMessage(message: Message): Message {
  const optional = (value: unknown) => typeof value === "string" && value ? value : undefined;
  const attachments = sanitizeAttachments(message.attachments);
  const recorded = message.voice as Partial<RecordedAudio> | undefined;
  const voice = recorded && typeof recorded.id === "string" && typeof recorded.mime === "string" && typeof recorded.seconds === "number"
    ? { id: recorded.id, mime: recorded.mime.slice(0, 60), seconds: Math.min(600, Math.max(0, recorded.seconds)), ...(recorded.silent === true ? { silent: true } : {}) }
    : undefined;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(Array.isArray(message.sources) ? { sources: message.sources } : {}),
    ...(optional(message.provider) ? { provider: message.provider } : {}),
    ...(optional(message.turn) ? { turn: message.turn } : {}),
    ...(optional(message.replyTo) ? { replyTo: message.replyTo } : {}),
    ...(optional(message.at) ? { at: message.at } : {}),
    ...(attachments ? { attachments } : {}),
    ...(voice ? { voice } : {}),
    ...(message.spoken === true ? { spoken: true } : {}),
    ...(message.failed === true ? { failed: true } : {}),
    ...(message.longform === true ? { longform: true } : {}),
    ...(message.initiative === true ? { initiative: true } : {}),
    ...(Array.isArray(message.reasoned) && message.reasoned.every((name) => name === "grok" || name === "groq" || name === "gemini") && message.reasoned.length ? { reasoned: message.reasoned } : {}),
    ...(message.command === "visualize" || message.command === "refine" || message.command === "image" ? { command: message.command } : {}),
    ...((REACTIONS as readonly string[]).includes(message.reaction ?? "") ? { reaction: message.reaction } : {}),
    ...((REACTIONS as readonly string[]).includes(message.herReaction ?? "") ? { herReaction: message.herReaction } : {}),
    ...(message.edited === true ? { edited: true } : {}),
    ...sanitizeMedia(message),
  };
}

/** Visualisations and pictures from storage: anything left mid-way by a reload reads as failed. */
function sanitizeMedia(message: Message): Pick<Message, "visualization" | "picture"> {
  const visual = message.visualization;
  if (visual && typeof visual.title === "string") {
    const spec = validateSpec(visual.spec);
    return { visualization: spec ? { title: visual.title.slice(0, 60), status: "ready", spec } : { title: visual.title.slice(0, 60), status: "error", error: visual.error || "This visualisation didn't finish." } };
  }
  const picture = message.picture;
  if (picture && typeof picture.prompt === "string") {
    const prompt = picture.prompt.slice(0, 600);
    if (picture.status === "ready" && picture.kind === "svg") {
      const svg = sanitizeSvg(picture.svg);
      return { picture: svg ? { status: "ready", kind: "svg", prompt, svg, ...(typeof picture.reason === "string" ? { reason: picture.reason } : {}) } : { status: "error", prompt, error: "This drawing couldn't be shown." } };
    }
    if (picture.status === "ready" && picture.kind === "generated") return { picture: { status: "ready", kind: "generated", prompt, ...(typeof picture.model === "string" ? { model: picture.model.slice(0, 60) } : {}) } };
    return { picture: { status: "error", prompt, error: typeof picture.error === "string" ? picture.error : "This picture didn't finish." } };
  }
  return {};
}

/**
 * What FREYA's model sees of a message. Commands and media cards become short notes, so she
 * knows a picture or visualisation happened without its data (an SVG or a spec) filling the
 * context; a voice note becomes what was measured and said.
 */
function forModel(message: Message): Message {
  if (message.voice) return { ...message, content: describeVoice(message.voice, message.content) };
  if (message.command) return { ...message, content: `(${message.command === "refine" ? "asked to change the visualisation on the canvas" : message.command === "image" ? "asked for a picture" : "asked for a 3D visualisation on the canvas"}: ${message.content})`, attachments: [] };
  if (message.visualization) return { ...message, content: message.visualization.status === "ready" ? `(showed them a 3D particle visualisation on the canvas: ${message.visualization.title})` : "(a visualisation didn't work)", attachments: [] };
  if (message.picture) {
    const picture = message.picture;
    return { ...message, attachments: [], content: picture.status !== "ready" ? "(a picture didn't work)" : picture.kind === "svg" ? `(sent them an SVG drawing, not a generated image, of: ${picture.prompt})` : `(sent them a generated picture of: ${picture.prompt})` };
  }
  return message;
}

/** Text for a failed card: the server's own message, never a raw browser network error. */
function cardError(error: unknown, fallback: string) {
  if (error instanceof TypeError) return "Couldn't reach the server. Check that it's running and try again.";
  return error instanceof Error && error.message ? error.message : fallback;
}

/** "make it…", "now add…": a follow-up that changes the last picture rather than starting over. */
function refinesPrevious(text: string) {
  return /^(make (it|her|him|them)|now\b|add\b|change\b|turn (it|her|him)|but\b|more\b|less\b|without\b|with\b|same\b|again\b|remove\b|zoom\b|darker|brighter|bigger|smaller)/i.test(text.trim());
}

function formatClock(iso?: string) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** What FREYA reads for a voice note: measured length and silence, then the words, if any. */
function describeVoice(voice: RecordedAudio, transcript: string) {
  const length = `${Math.max(1, Math.round(voice.seconds))}s`;
  if (voice.silent) return `(voice message, ${length}, measured as completely silent: no voice, no sound)`;
  if (!transcript.trim()) return `(voice message, ${length}, sounds but no words could be made out)`;
  return `(voice message, ${length}) ${transcript}`;
}

const delay = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

/** Stored history is user-editable local data, so every field is re-checked before use. */
function normalizeConversations(value: unknown): Conversation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    const messages = Array.isArray(candidate.messages) ? candidate.messages.filter(isMessage).map(sanitizeMessage) : [];
    const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString();
    const unread = typeof candidate.unread === "number" && candidate.unread > 0 ? Math.min(99, Math.floor(candidate.unread)) : 0;
    return [{
      id: typeof candidate.id === "string" ? candidate.id : id(),
      title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : UNTITLED,
      messages,
      createdAt,
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : createdAt,
      ...(unread ? { unread } : {}),
      ...(typeof candidate.reflectedCount === "number" && candidate.reflectedCount > 0 ? { reflectedCount: Math.min(messages.length, Math.floor(candidate.reflectedCount)) } : {}),
      ...(typeof candidate.recap === "string" && candidate.recap.trim() ? { recap: candidate.recap.slice(0, 320) } : {}),
    }];
  }).slice(0, MAX_CONVERSATIONS);
}

/** What FREYA gets to know about the user's other conversations when replying in this one. */
function continuityOf(conversations: Conversation[], conversationId: string, latestText: string) {
  let resetAt = "";
  try { resetAt = localStorage.getItem(MEMORY_RESET_KEY) ?? ""; } catch { /* no reset recorded */ }
  const chapters = chaptersForPrompt(conversations, conversationId, { recentTexts: [latestText], forgotten: loadForgotten(), resetAt });
  const relationship = relationshipFacts(conversations, conversationId, resetAt);
  return { totals: historyTotals(conversations, resetAt), ...(relationship ? { chapters, relationship } : {}) };
}

/** Notes kept in this browser (no account, or cloud memory not configured). */
function readLocalMemories(): Memory[] {
  try { return normalizeStoredMemories(JSON.parse(localStorage.getItem(MEMORY_KEY) || "[]")); } catch { return []; }
}

/** The user's local calendar date, for dating what automatic memory saves. */
function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatRelative(iso: string) {
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "NOW";
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "NOW";
  if (minutes < 60) return `${minutes}M`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H`;
  return `${Math.floor(hours / 24)}D`;
}

type ReplyStreamHandlers = {
  onMeta: (sources: Source[], searchStatus: string, reasoned: string[], herBusy: boolean) => void;
  onProvider: (provider: string) => void;
  onDelta: (delta: string) => void;
  onDone: (data: { truncated?: boolean } | null) => void;
  onError: (message: string) => void;
};

/** Reads the chat route's SSE body, dispatching meta/delta/error events as they arrive. */
async function readReplyStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, handlers: ReplyStreamHandlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = block.match(/^event: (.+)$/m)?.[1];
        const raw = block.match(/^data: ([\s\S]*)$/m)?.[1];
        if (event && raw) {
          let data: unknown;
          try { data = JSON.parse(raw); } catch { data = null; }
          if (event === "meta") {
            const sources = (data as { sources?: unknown })?.sources;
            const searchStatus = (data as { searchStatus?: unknown })?.searchStatus;
            const reasoned = (data as { reasoned?: unknown })?.reasoned;
            handlers.onMeta(
              Array.isArray(sources) ? sources as Source[] : [],
              typeof searchStatus === "string" ? searchStatus : "",
              Array.isArray(reasoned) ? reasoned.filter((name): name is string => typeof name === "string") : [],
              (data as { herBusy?: unknown })?.herBusy === true,
            );
          } else if (event === "provider" && typeof (data as { provider?: unknown })?.provider === "string") {
            handlers.onProvider((data as { provider: string }).provider);
          } else if (event === "delta" && typeof data === "string") {
            handlers.onDelta(data);
          } else if (event === "done") {
            handlers.onDone(data as { truncated?: boolean } | null);
          } else if (event === "error") {
            handlers.onError((data as { error?: string })?.error || "The reply failed partway through.");
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function conversationToMarkdown(conversation: Conversation) {
  const lines = [`# ${conversation.title}`, "", `_Exported ${new Date().toLocaleString()}_`, ""];
  let previousRole = "";
  for (const message of conversation.messages) {
    // A reply's parts read as one section, as they would in the chat.
    if (message.role !== previousRole) lines.push(`## ${message.role === "assistant" ? "FREYA" : "You"}`, "");
    previousRole = message.role;
    lines.push(message.content, "");
    if (message.attachments?.length) lines.push(`_Attachments: ${message.attachments.map((item) => item.name).join(", ")}_`, "");
    if (message.sources?.length) {
      lines.push("**Sources**", "");
      for (const source of message.sources) lines.push(`- [${source.title}](${source.url})`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [conversationFilter, setConversationFilter] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [memoryText, setMemoryText] = useState("");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const memoriesRef = useRef<Memory[]>([]);
  const reflectingRef = useRef(new Set<string>());
  const reflectTimersRef = useRef(new Map<string, number>());
  const reflectRef = useRef<(conversationId: string) => void>(() => {});
  const [characterProfile, setCharacterProfile] = useState<CharacterProfile>(() => createDefaultCharacterProfile());
  const [profileRevisions, setProfileRevisions] = useState<PersonalityRevision[]>([]);
  const [personalityProposals, setPersonalityProposals] = useState<PersonalityProposal[]>([]);
  const [cloudProfileReady, setCloudProfileReady] = useState(!supabase);
  const [cloudProfileAvailable, setCloudProfileAvailable] = useState(!supabase);
  const [autonomyLevel, setAutonomyLevel] = useState<0 | 1 | 2>(1);
  const [privacyMode, setPrivacyMode] = useState(false);
  /** The server-owned AI setup (display only): Local-only mode's model and the reasoning setting. */
  const [serverSetup, setServerSetup] = useState<{ localModel: string | null; localReady: boolean; reasoning: ReasoningMode; voiceOnThisMachine: boolean }>({ localModel: null, localReady: false, reasoning: "auto", voiceOnThisMachine: true });
  /** freya.config.json's switches: these beat the browser's own settings. */
  const [switches, setSwitches] = useState<FreyaConfig>({});
  const [autoMemory, setAutoMemory] = useState(true);
  const [candidLanguage, setCandidLanguage] = useState(true);
  /** The message the next one replies to. */
  const [replyingToId, setReplyingToId] = useState("");
  /** The visualisation card whose Refine button was used: the next message changes that form. */
  const [refiningId, setRefiningId] = useState("");
  /** The message whose reaction picker is open, the one being edited, and the one just copied. */
  const [reactingToId, setReactingToId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editText, setEditText] = useState("");
  const [copiedId, setCopiedId] = useState("");
  /** The /visualize form on the canvas, if any. */
  const [canvasForm, setCanvasForm] = useState<CanvasForm | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"profile" | "settings">("profile");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [speechRequest, setSpeechRequest] = useState<SpeechRequest>(null);
  const [style, setStyle] = useState<Style>("adaptive");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ask, setAsk] = useState<AskRequest | null>(null);
  const askResolve = useRef<((value: string | boolean | null) => void) | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  /** The conversation FREYA is typing in right now, if any. */
  const [typingIn, setTypingIn] = useState("");
  /** Conversations with a reply running or waiting in the queue. */
  const [replyingIn, setReplyingIn] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<AttachmentMeta[]>([]);
  const [preparingFiles, setPreparingFiles] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [notificationsOn, setNotificationsOn] = useState(false);
  /** FREYA's mood. Starts neutral for the server render, then loads from this browser. */
  const [mood, setMood] = useState<MoodState>(() => initialMood(0));
  const [initiativeOn, setInitiativeOn] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  /** Adult roleplay, opt-in after an 18+ confirmation. */
  const [intimateMode, setIntimateMode] = useState(false);
  /** "I know she's an AI, don't remind me": she dodges the question (lib/honesty). */
  const [stayInCharacter, setStayInCharacter] = useState(false);
  /** She takes a while to answer when her day says she's busy. */
  const [realisticTiming, setRealisticTiming] = useState(true);
  const [feedbackCount, setFeedbackCount] = useState(0);
  /** The conversation where the panel is working right now, for the "thinking it through" label. */
  const [deliberatingIn, setDeliberatingIn] = useState("");
  /** A short-lived facial reaction (their news, a joke, "smile for me"); then her mood shows again. */
  const [reaction, setReaction] = useState<(Reaction & { until: number }) | null>(null);
  const react = useCallback((next: Reaction | null) => { if (next) setReaction({ ...next, until: Date.now() + next.ms }); }, []);
  useEffect(() => {
    if (!reaction) return;
    const timer = window.setTimeout(() => setReaction((current) => current === reaction ? null : current), Math.max(0, reaction.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [reaction]);
  /** Set when a reply used up its continuation budget and still had more to say. */
  const [truncatedReplyId, setTruncatedReplyId] = useState("");
  const [user, setUser] = useState<User | null>(null);
  /** Signed in with cloud memory configured: notes live in the account, otherwise in this browser. */
  const memoryInCloud = Boolean(supabase && user);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shouldAutoScroll = useRef(true);
  const atBottomRef = useRef(true);
  const activeIdRef = useRef("");
  const activeChatRequest = useRef<AbortController | null>(null);
  const cloudProfileSnapshot = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Replies run one at a time, in order; messages sent meanwhile wait here. */
  const jobsRef = useRef<ReplyJob[]>([]);
  const activeJobRef = useRef<ReplyJob | null>(null);
  const workerRef = useRef(false);
  const conversationsRef = useRef<Conversation[]>([]);
  const runReplyRef = useRef<(job: ReplyJob) => Promise<void>>(async () => {});
  const notificationsRef = useRef(false);
  const soundRef = useRef(true);
  /** Messages the running reply has put on screen; 0 means it can still be called off. */
  const activePostedRef = useRef(0);
  const moodRef = useRef<MoodState>(mood);
  const moodLoadedRef = useRef(false);
  const initiativeRef = useRef({ on: true, autonomy: 1 as 0 | 1 | 2 });
  const baseTitleRef = useRef("");

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { notificationsRef.current = notificationsOn; }, [notificationsOn]);
  useEffect(() => { soundRef.current = soundOn; }, [soundOn]);
  // Saved only once the stored mood has been read: saving first overwrote it with the blank
  // starting state, so her mood was lost on every reload.
  useEffect(() => { moodRef.current = mood; if (moodLoadedRef.current) saveMood(mood); }, [mood]);
  useEffect(() => { initiativeRef.current = { on: switches.textsFirst ?? initiativeOn, autonomy: autonomyLevel }; }, [switches.textsFirst, initiativeOn, autonomyLevel]);

  // Chrome fills the voice list asynchronously, so prime it before the first Speak press.
  useEffect(() => { primeVoices(); }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const level = Number(localStorage.getItem(AUTONOMY_KEY));
      setAutonomyLevel(level === 0 || level === 2 ? level : 1);
      setPrivacyMode(localStorage.getItem(PRIVACY_KEY) === "true");
      setAutoMemory(localStorage.getItem(AUTO_MEMORY_KEY) !== "false");
      setMemoryEnabled(localStorage.getItem(MEMORY_ENABLED_KEY) !== "false");
      setCandidLanguage(localStorage.getItem(CANDID_LANGUAGE_KEY) !== "false");
      // Permission can be revoked in browser settings between visits; the toggle follows it.
      setNotificationsOn(localStorage.getItem(NOTIFICATIONS_KEY) === "true" && notificationState() === "granted");
      setInitiativeOn(localStorage.getItem(INITIATIVE_KEY) !== "false");
      setSoundOn(localStorage.getItem(SOUND_KEY) !== "false");
      setIntimateMode(localStorage.getItem(INTIMATE_KEY) === "true");
      setStayInCharacter(localStorage.getItem(STAY_IN_CHARACTER_KEY) === "true");
      setRealisticTiming(localStorage.getItem(REALISTIC_TIMING_KEY) !== "false");
      setFeedbackCount(loadFeedback().length);
      moodLoadedRef.current = true;
      setMood(resumeMood(loadMood()));
    } catch { /* Defaults remain safe when local settings storage is unavailable. */ }
  }, [hydrated]);

  // A restarted server means she starts again at neutral (lib/mood resumeMood).
  const checkServerRun = useCallback(() => {
    fetch("/api/session", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (typeof payload?.bootId === "string") setMood((current) => resumeMood(current, Date.now(), payload.bootId));
        if (payload?.switches && typeof payload.switches === "object") setSwitches(payload.switches);
      })
      .catch(() => { /* Server unreachable: nothing to compare yet. */ });
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    checkServerRun();
    // Coming back from flipping a switch in a terminal or editor.
    window.addEventListener("focus", checkServerRun);
    return () => window.removeEventListener("focus", checkServerRun);
  }, [hydrated, checkServerRun]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(AUTONOMY_KEY, String(autonomyLevel));
      localStorage.setItem(PRIVACY_KEY, String(privacyMode));
      localStorage.setItem(AUTO_MEMORY_KEY, String(autoMemory));
      localStorage.setItem(MEMORY_ENABLED_KEY, String(memoryEnabled));
      localStorage.setItem(CANDID_LANGUAGE_KEY, String(candidLanguage));
      localStorage.setItem(NOTIFICATIONS_KEY, String(notificationsOn));
      localStorage.setItem(INITIATIVE_KEY, String(initiativeOn));
      localStorage.setItem(SOUND_KEY, String(soundOn));
      localStorage.setItem(INTIMATE_KEY, String(intimateMode));
      localStorage.setItem(STAY_IN_CHARACTER_KEY, String(stayInCharacter));
      localStorage.setItem(REALISTIC_TIMING_KEY, String(realisticTiming));
    } catch { /* Settings still apply for this session. */ }
  }, [autonomyLevel, privacyMode, autoMemory, memoryEnabled, candidLanguage, notificationsOn, initiativeOn, soundOn, intimateMode, stayInCharacter, realisticTiming, hydrated]);

  useEffect(() => {
    let active = true;
    // Models and routing are server-owned; this only shows what the server is set up to use.
    // The old per-browser model choice silently sent every message to the local model.
    try { localStorage.removeItem(MODEL_KEY); localStorage.removeItem(REASONING_KEY); } catch { /* nothing stored */ }
    fetch("/api/models", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!active || !response.ok || !payload) return;
      setServerSetup({
        localModel: typeof payload.defaultModel === "string" ? payload.defaultModel : null,
        localReady: payload.ollama === "ready",
        reasoning: isReasoningMode(payload.reasoning) ? payload.reasoning : "auto",
        voiceOnThisMachine: payload.voiceOnThisMachine !== false,
      });
    }).catch(() => { /* Display only; chat works without it. */ });
    return () => { active = false; };
  }, []);

  const notify = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, text, tone }]);
    // Errors linger longer than confirmations, but nothing stays forever.
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)),
      tone === "error" ? 9000 : 5000);
  }, []);

  /** Promise-based replacement for window.confirm / window.prompt. */
  const askFor = useCallback((request: AskRequest) => new Promise<string | boolean | null>((resolve) => {
    askResolve.current = resolve;
    setAsk(request);
  }), []);

  const resolveAsk = useCallback((value: string | boolean | null) => {
    setAsk(null);
    askResolve.current?.(value);
    askResolve.current = null;
  }, []);


  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId),
    [conversations, activeId],
  );
  const messages = activeConversation?.messages ?? NO_MESSAGES;

  const visibleConversations = useMemo(() => {
    const query = conversationFilter.trim().toLowerCase();
    const sorted = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!query) return sorted;
    return sorted.filter((conversation) =>
      conversation.title.toLowerCase().includes(query)
      || conversation.messages.some((message) => message.content.toLowerCase().includes(query)));
  }, [conversations, conversationFilter]);

  const updateActiveMessages = useCallback((updater: (previous: Message[]) => Message[]) => {
    setConversations((previous) => previous.map((conversation) => {
      if (conversation.id !== activeIdRef.current) return conversation;
      const nextMessages = updater(conversation.messages);
      const firstUserMessage = nextMessages.find((message) => message.role === "user");
      const opening = firstUserMessage ? firstUserMessage.content || firstUserMessage.attachments?.[0]?.name || "" : "";
      return {
        ...conversation,
        messages: nextMessages,
        title: conversation.title === UNTITLED && opening ? deriveTitle(opening) : conversation.title,
        updatedAt: new Date().toISOString(),
      };
    }));
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const syncDrawerForViewport = () => setDrawerOpen(!media.matches);
    syncDrawerForViewport();
    media.addEventListener("change", syncDrawerForViewport);
    return () => media.removeEventListener("change", syncDrawerForViewport);
  }, []);

  // Modal dialog: trap Tab, lock background scrolling, and hand focus back on close.
  useEffect(() => {
    if (!settingsOpen) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);
    focusables()[0]?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { setSettingsOpen(false); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length < 2) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [settingsOpen]);

  function loadSavedCharacterProfile() {
    try {
      const saved = localStorage.getItem(CHARACTER_PROFILE_KEY);
      if (saved) setCharacterProfile(normalizeCharacterProfile(JSON.parse(saved)));
    } catch {
      notify(reportError("profile", "dossier parse failed", "Using FREYA's initial profile; the saved one could not be read."), "error");
    }
  }

  function loadConversations() {
    let stored = normalizeConversations(JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) || "null"));
    if (!stored.length) {
      // One-time migration from the single-session chat cache this replaced.
      const legacy = sessionStorage.getItem(LEGACY_CHAT_KEY);
      if (legacy) {
        const legacyMessages = Array.isArray(JSON.parse(legacy)) ? (JSON.parse(legacy) as unknown[]).filter(isMessage) : [];
        if (legacyMessages.length) {
          const firstUserMessage = legacyMessages.find((message) => message.role === "user");
          const now = new Date().toISOString();
          stored = [{ id: id(), title: firstUserMessage ? deriveTitle(firstUserMessage.content) : UNTITLED, messages: legacyMessages, createdAt: now, updatedAt: now }];
        }
        sessionStorage.removeItem(LEGACY_CHAT_KEY);
      }
    }
    if (!stored.length) stored = [createConversation()];
    const savedActiveId = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
    setConversations(stored);
    setActiveId(stored.some((conversation) => conversation.id === savedActiveId) ? savedActiveId! : stored[0].id);
  }

  useEffect(() => {
    let active = true;
    const loadLocalData = () => {
      try {
        loadSavedCharacterProfile();
        loadConversations();
        if (active) setMemories(readLocalMemories());
      } catch {
        if (active) {
          setConversations([createConversation()]);
          notify(reportError("storage", "local hydrate failed", "Saved data could not be loaded in this browser."), "error");
        }
      } finally {
        if (active) setHydrated(true);
      }
    };
    if (!supabase) {
      loadLocalData();
      return () => { active = false; };
    }
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) notify(reportError("auth", error, "Could not check your sign-in session."), "error");
      setUser(data.session?.user ?? null);
      setCloudProfileReady(!data.session?.user);
      loadSavedCharacterProfile();
      try { loadConversations(); } catch { setConversations([createConversation()]); }
      setHydrated(true);
      if (data.session?.user) void loadCloudMemories();
      else setMemories(readLocalMemories());
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      setCloudProfileReady(!session?.user);
      if (session?.user) void loadCloudMemories();
      else setMemories(readLocalMemories());
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
    // Hydration runs once on mount; re-running it would discard in-progress state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadCloudMemories() {
    if (!supabase) return;
    const { data, error } = await supabase.from("memories").select("id,content,created_at,updated_at").order("created_at", { ascending: false }).limit(100);
    if (error) {
      notify(reportError("memory", error, "Your saved memories could not be loaded."), "error");
      return;
    }
    setMemories((data ?? []).map((row) => ({ id: row.id, text: row.content, createdAt: row.created_at, updatedAt: row.updated_at })));
  }

  async function submitAuth(mode: "signin" | "signup", event?: FormEvent) {
    event?.preventDefault();
    if (!supabase) return;
    if (!authEmail.trim() || authPassword.length < 6) {
      notify("Enter a valid email and a password with at least 6 characters.", "error");
      return;
    }
    setAuthBusy(true);
    setToasts([]);
    try {
      const result = mode === "signup"
        ? await supabase.auth.signUp({ email: authEmail.trim(), password: authPassword })
        : await supabase.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword });
      if (result.error) throw result.error;
      if (mode === "signup" && !result.data.session) notify("Account created. Check your email to confirm it, then sign in.");
      else notify(mode === "signup" ? "Account created and signed in." : "Signed in. Cloud memories are loading.");
      setAuthPassword("");
    } catch (error) {
      notify(reportError("auth", error), "error");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) notify(reportError("auth", error, "Sign-out did not complete."), "error");
    else { setUser(null); setMemories(readLocalMemories()); loadSavedCharacterProfile(); setProfileRevisions([]); setPersonalityProposals([]); notify("Signed out. Cloud memories remain in your account."); }
  }

  async function personalityRequest(body: Record<string, unknown>) {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Sign in to save FREYA's character history.");
    const response = await fetch("/api/personality", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Character history update failed.");
    return payload;
  }

  async function refreshPersonalityHistory() {
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const response = await fetch("/api/personality", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload.profile) {
      const profile = normalizeCharacterProfile(payload.profile);
      cloudProfileSnapshot.current = JSON.stringify(profile);
      setCharacterProfile(profile);
    }
    if (Array.isArray(payload.revisions)) setProfileRevisions(payload.revisions);
    if (Array.isArray(payload.proposals)) setPersonalityProposals(payload.proposals);
  }

  async function rollbackProfile(revision: number) {
    try {
      const result = await personalityRequest({ action: "rollback", revision });
      const profile = normalizeCharacterProfile(result.profile);
      cloudProfileSnapshot.current = JSON.stringify(profile);
      setCharacterProfile(profile);
      await refreshPersonalityHistory();
      notify(`Restored profile revision ${revision}. A new revision records the rollback.`);
    } catch (error) { notify(reportError("profile", error, "That revision could not be restored."), "error"); }
  }

  async function reviewProposal(id: string, decision: "approved" | "rejected" | "disputed" | "archived") {
    try {
      const result = await personalityRequest({ action: "review", id, decision });
      if (result.profile) {
        const profile = normalizeCharacterProfile(result.profile);
        cloudProfileSnapshot.current = JSON.stringify(profile);
        setCharacterProfile(profile);
      }
      await refreshPersonalityHistory();
    } catch (error) { notify(reportError("profile", error, "That proposal could not be reviewed."), "error"); }
  }

  async function reflectOnConversation(turns: Message[] = activeConversation?.messages ?? [], quiet = false) {
    if (!user || !cloudProfileAvailable || autonomyLevel === 0) return;
    const candidates = deriveReflectionCandidates(turns);
    if (!candidates.length) {
      if (!quiet) notify("No recurring low-risk topic appeared enough times to support a proposal.");
      return;
    }
    try {
      for (const candidate of candidates.slice(0, 1)) {
        const saved = await personalityRequest({ action: "propose", ...candidate });
        if (autonomyLevel === 2) await personalityRequest({ action: "review", id: saved.proposal.id, decision: "approved" });
      }
      await refreshPersonalityHistory();
      notify(autonomyLevel === 2 ? "Low-risk reflection was added as tentative preferences." : "Reflection proposals are ready for your review.");
    } catch (error) { notify(reportError("reflection", error), "error"); }
  }

  useEffect(() => {
    if (!supabase || !user || !hydrated) {
      if (!user && hydrated) setCloudProfileReady(true);
      return;
    }
    let active = true;
    setCloudProfileReady(false);
    setCloudProfileAvailable(false);
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) return;
        const response = await fetch("/api/personality", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 503) notify("Persistent character storage needs the additive supabase/personality.sql migration. This browser profile is still available.", "info");
          return;
        }
        if (!active) return;
        setCloudProfileAvailable(true);
        const profile = normalizeCharacterProfile(payload.profile);
        cloudProfileSnapshot.current = JSON.stringify(profile);
        setCharacterProfile(profile);
        setProfileRevisions(Array.isArray(payload.revisions) ? payload.revisions : []);
        setPersonalityProposals(Array.isArray(payload.proposals) ? payload.proposals : []);
      } catch {
        if (active) notify("Cloud character profile could not be loaded; the browser profile remains available.", "info");
      } finally {
        if (active) setCloudProfileReady(true);
      }
    })();
    return () => { active = false; };
  }, [user, hydrated, notify]);

  useEffect(() => {
    if (!hydrated || (supabase && user && !cloudProfileReady)) return;
    const serializedProfile = JSON.stringify(characterProfile);
    if (supabase && user && serializedProfile === cloudProfileSnapshot.current) return;
    const save = async () => {
      if (supabase && user && cloudProfileAvailable) {
        try {
          const { data } = await supabase.auth.getSession();
          const token = data.session?.access_token;
          if (!token) return;
          const response = await fetch("/api/personality", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: "save", profile: characterProfile, summary: "Character dossier edited by the user." }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || "Cloud save failed.");
          cloudProfileSnapshot.current = JSON.stringify(result.profile);
          setProfileRevisions((previous) => [{ revision: result.revision, profile: result.profile, summary: "Character dossier edited by the user.", rollback_from: null, created_at: new Date().toISOString() }, ...previous].slice(0, 20));
        } catch {
          notify(reportError("profile", "cloud dossier sync failed", "The dossier changed here but did not sync."), "error");
        }
      } else {
        try { localStorage.setItem(CHARACTER_PROFILE_KEY, JSON.stringify(characterProfile)); }
        catch (error) { notify(reportError("profile", error, "The dossier changed but this browser could not save it."), "error"); }
      }
    };
    const timer = window.setTimeout(() => void save(), 900);
    return () => window.clearTimeout(timer);
  }, [characterProfile, hydrated, user, cloudProfileReady, cloudProfileAvailable, notify]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations.slice(0, MAX_CONVERSATIONS)));
      if (activeId) localStorage.setItem(ACTIVE_CONVERSATION_KEY, activeId);
    } catch {
      notify(reportError("storage", "conversation persist failed", "This browser could not save your conversation."), "error");
    }
  }, [conversations, activeId, hydrated, notify]);

  const scrollToBottom = useCallback((smooth = true) => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bottomRef.current?.scrollIntoView({ behavior: smooth && !reduceMotion ? "smooth" : "auto", block: "end" });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (shouldAutoScroll.current || atBottomRef.current) {
      scrollToBottom(shouldAutoScroll.current);
      shouldAutoScroll.current = false;
    }
  }, [messages.length, typingIn, hydrated, scrollToBottom]);

  /**
   * Her own clock. Once a minute her mood may drift, and if she feels like it she texts first:
   * only after they've been quiet a while, never more than twice without an answer, more
   * often when she has energy. Level 0 autonomy or the setting switched off stops it.
   */
  useEffect(() => {
    if (!hydrated) return;
    const tick = () => {
      // Her mood only changes with the conversation; the clock only checks for a long gap or a restart.
      checkServerRun();
      setMood((current) => resumeMood(current));
      const state = moodRef.current;
      const now = Date.now();
      const { on, autonomy } = initiativeRef.current;
      if (!on || autonomy === 0 || workerRef.current || jobsRef.current.length) return;
      if (state.unprompted >= 2 || now < state.nextInitiativeAt || now - state.lastUserAt < 4 * 60_000) return;
      const conversation = conversationsRef.current.find((item) => item.id === activeIdRef.current);
      const last = conversation?.messages.at(-1);
      // Only into a conversation that exists and isn't waiting on her to answer.
      if (!conversation || !last || last.role !== "assistant") return;
      const gap = ((8 + Math.random() * 37) * 60_000) / Math.max(0.3, state.energy);
      setMood((current) => ({ ...current, nextInitiativeAt: now + gap }));
      enqueueReply({ conversationId: conversation.id, targetId: last.id, initiative: true });
    };
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
    // Reads everything through refs; restarting the clock on each render would reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // Opening a conversation (or returning to the tab) marks its replies as read.
  useEffect(() => {
    const markRead = () => {
      if (document.hidden) return;
      setConversations((previous) => previous.some((conversation) => conversation.id === activeIdRef.current && conversation.unread)
        ? previous.map((conversation) => conversation.id === activeIdRef.current ? { ...conversation, unread: 0 } : conversation)
        : previous);
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    window.addEventListener("focus", markRead);
    return () => {
      document.removeEventListener("visibilitychange", markRead);
      window.removeEventListener("focus", markRead);
    };
  }, [activeId]);

  const totalUnread = conversations.reduce((total, conversation) => total + (conversation.unread ?? 0), 0);
  useEffect(() => {
    baseTitleRef.current ||= document.title;
    document.title = totalUnread ? `(${totalUnread}) ${baseTitleRef.current}` : baseTitleRef.current;
  }, [totalUnread]);

  function handleConversationScroll() {
    const element = conversationRef.current;
    if (!element) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
    atBottomRef.current = near;
    setAtBottom(near);
  }

  // Auto-grow the composer up to a ceiling, then let it scroll internally.
  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 140)}px`;
  }, [input]);

  function selectConversation(conversationId: string) {
    if (conversationId === activeId) { setDrawerOpen((open) => (window.innerWidth <= 700 ? false : open)); return; }
    // Leaving a conversation is a natural point to remember what mattered in it.
    reflectRef.current(activeIdRef.current);
    setReplyingToId("");
    setRefiningId("");
    setEditingId("");
    setReactingToId("");
    // A reply in progress keeps going in the background and lands in its own conversation.
    activeIdRef.current = conversationId;
    setActiveId(conversationId);
    shouldAutoScroll.current = true;
    atBottomRef.current = true;
    setAtBottom(true);
    if (window.innerWidth <= 700) setDrawerOpen(false);
  }

  const newConversation = useCallback(() => {
    reflectRef.current(activeIdRef.current);
    // Decided outside the state updater: React may run an updater twice (it does in development),
    // and creating the conversation in there made two ids, leaving the active one pointing at a
    // conversation that was never stored, so the next message vanished.
    const empty = conversationsRef.current.find((conversation) => !conversation.messages.length);
    const target = empty ?? createConversation();
    activeIdRef.current = target.id;
    setActiveId(target.id);
    // Reuse an untouched conversation rather than stacking up empty ones.
    if (!empty) setConversations((previous) => [target, ...previous.filter((conversation) => conversation.id !== target.id)].slice(0, MAX_CONVERSATIONS));
    setInput("");
    shouldAutoScroll.current = true;
    atBottomRef.current = true;
    setAtBottom(true);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  async function deleteConversation(conversationId: string) {
    const target = conversations.find((conversation) => conversation.id === conversationId);
    if (target?.messages.length) {
      const confirmed = await askFor({
        title: "Delete this conversation?",
        body: `"${target.title}" and its ${target.messages.length} messages will be removed. This cannot be undone. Anything FREYA remembered from it stays in Memory, where you can delete it separately.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) return;
    }
    cancelRepliesFor(conversationId);
    void deleteAttachments(target?.messages.flatMap((message) => message.attachments?.map((item) => item.id) ?? []) ?? []);
    // Worked out before the update (an updater may run twice), so the active id always exists.
    const remaining = conversationsRef.current.filter((conversation) => conversation.id !== conversationId);
    const replacement = remaining.length ? null : createConversation();
    if (conversationId === activeIdRef.current) {
      const nextId = replacement?.id ?? remaining[0].id;
      activeIdRef.current = nextId;
      setActiveId(nextId);
    }
    setConversations((previous) => {
      const kept = previous.filter((conversation) => conversation.id !== conversationId);
      return kept.length ? kept : [replacement ?? createConversation()];
    });
    notify("Conversation deleted.");
  }

  async function renameConversation(conversationId: string) {
    const target = conversations.find((conversation) => conversation.id === conversationId);
    const answer = await askFor({
      title: "Rename conversation",
      field: { label: "Title", value: target?.title ?? "", placeholder: "New subject", maxLength: 80 },
      confirmLabel: "Rename",
    });
    const nextTitle = typeof answer === "string" ? answer.trim() : "";
    if (!nextTitle) return;
    setConversations((previous) => previous.map((conversation) =>
      conversation.id === conversationId ? { ...conversation, title: deriveTitle(nextTitle) } : conversation));
  }

  function exportActiveConversation() {
    if (!activeConversation?.messages.length) { notify("This conversation is empty, so there is nothing to export.", "error"); return; }
    const blob = new Blob([conversationToMarkdown(activeConversation)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `freya-${activeConversation.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) || "chat"}.md`;
    link.click();
    URL.revokeObjectURL(url);
    notify("Conversation exported as Markdown.");
  }

  /** Replies marked "not her", as a file for training/data/ (lib/feedback). */
  function exportFeedback() {
    const entries = loadFeedback();
    if (!entries.length) { notify("Nothing marked yet. Hover over one of her messages and press ⚑.", "error"); return; }
    const blob = new Blob([feedbackToJsonl(entries)], { type: "application/x-ndjson;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "freya-feedback.jsonl";
    link.click();
    URL.revokeObjectURL(url);
    notify("Saved. Put the file in training/data/ before the next fine-tune.");
  }

  /** The reply sounded wrong: keep it, and what she should have said, to train on later. */
  async function markNotHer(message: Message) {
    const thread = conversationsRef.current.find((conversation) => conversation.id === activeIdRef.current)?.messages ?? [];
    const better = await askFor({
      title: "Not her?",
      body: "What should she have said? You can leave this empty. It stays in this browser until you export it.",
      field: { label: "What she should have said", value: "", placeholder: "Optional", maxLength: 1000 },
      confirmLabel: "Save",
    });
    if (better === null) return;
    const entry = feedbackFor(thread.map(forModel), thread.findIndex((item) => item.id === message.id), typeof better === "string" ? better : "");
    if (!entry) { notify("That message can't be used: it has nothing before it to answer.", "error"); return; }
    const entries = [...loadFeedback(), entry];
    saveFeedback(entries);
    setFeedbackCount(entries.length);
    notify("Noted.");
  }

  function saveLocalMemories(next: Memory[]) {
    setMemories(next);
    localStorage.setItem(MEMORY_KEY, JSON.stringify(next));
  }

  /**
   * Local-only mode can't use automatic memory (it would send the chat to a hosted model), so
   * there, and only there, the old on-device rule still saves explicit "I prefer…" statements,
   * to this browser only: Local-only never writes to the cloud.
   */
  async function autoSaveExplicitPreference(userText: string) {
    if (!autoMemory || !memoryEnabled || !privacyMode || memoryInCloud) return;
    const candidate = captureExplicitPreference(userText);
    if (!candidate || memories.length >= LOCAL_MEMORY_LIMIT || memories.some((memory) => memory.text.toLowerCase() === candidate.toLowerCase())) return;
    const timestamp = new Date().toISOString();
    saveLocalMemories([{ id: id(), text: candidate, createdAt: timestamp, updatedAt: timestamp, kind: "preference", source: "freya" }, ...memories]);
    notify(`FREYA will remember: "${candidate}"`);
  }

  /** Saves validated automatic-memory changes where the notes live. True only if all of it saved. */
  async function applyMemoryChanges(changes: MemoryChanges): Promise<boolean> {
    if (memoryInCloud && supabase && user) {
      for (const item of changes.remove) {
        const { error } = await supabase.from("memories").delete().eq("id", item.id);
        if (error) { reportError("memory", error); return false; }
      }
      for (const item of changes.update) {
        const { error } = await supabase.from("memories").update({ content: item.text, updated_at: new Date().toISOString() }).eq("id", item.id);
        if (error) { reportError("memory", error); return false; }
      }
      if (changes.add.length) {
        const { error } = await supabase.from("memories").insert(changes.add.map((item) => ({ content: item.text, user_id: user.id })));
        if (error) { reportError("memory", error); return false; }
      }
      await loadCloudMemories();
      return true;
    }
    saveLocalMemories(applyChangesLocally(memoriesRef.current, changes, new Date().toISOString(), id));
    return true;
  }

  function markReflected(conversationId: string, upTo: number, recap?: string) {
    setConversations((previous) => previous.map((conversation) => conversation.id === conversationId
      ? { ...conversation, reflectedCount: Math.max(conversation.reflectedCount ?? 0, upTo), ...(recap ? { recap } : {}) }
      : conversation));
  }

  /**
   * Automatic memory: reads what is new in a conversation and saves what is worth keeping.
   * Runs after a quiet spell, when you switch conversations or leave the tab, and once after
   * loading for anything left unread. Never in Local-only mode, never with memory off.
   */
  async function reflectConversation(conversationId: string) {
    if (!hydrated || !autoMemory || !memoryEnabled || privacyMode || reflectingRef.current.has(conversationId)) return;
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation) return;
    const settled = conversation.messages.filter((message) => !message.streaming && !message.failed && !message.command && !message.visualization && !message.picture);
    const window = reflectionWindow(settled.map(({ role, content }) => ({ role, content })), conversation.reflectedCount ?? 0, intimateMode);
    if (!window) return;
    reflectingRef.current.add(conversationId);
    try {
      const response = await fetch("/api/memory/reflect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turns: window.turns,
          memories: memoriesRef.current.map((memory) => ({ id: memory.id, text: memory.text })),
          forgotten: loadForgotten(),
          today: localDate(),
          ...(conversation.recap ? { recap: conversation.recap } : {}),
        }),
      });
      if (!response.ok) return;
      const changes = await response.json() as MemoryChanges & { recap?: unknown };
      if (!Array.isArray(changes.add) || !Array.isArray(changes.update) || !Array.isArray(changes.remove)) return;
      if (!await applyMemoryChanges(changes)) return;
      markReflected(conversationId, window.upTo, typeof changes.recap === "string" ? changes.recap : undefined);
      const line = describeChanges(changes);
      if (line) notify(line);
    } catch (error) {
      reportError("memory", error);
    } finally {
      reflectingRef.current.delete(conversationId);
    }
  }
  useEffect(() => { reflectRef.current = (conversationId) => { void reflectConversation(conversationId); }; });

  function scheduleReflection(conversationId: string, after = REFLECT_AFTER_MS) {
    window.clearTimeout(reflectTimersRef.current.get(conversationId));
    reflectTimersRef.current.set(conversationId, window.setTimeout(() => {
      reflectTimersRef.current.delete(conversationId);
      reflectRef.current(conversationId);
    }, after));
  }

  async function addMemory(event: FormEvent) {
    event.preventDefault();
    const text = memoryText.trim();
    if (!text) return;
    if (text.length > 240) { notify("Keep each memory under 240 characters.", "error"); return; }
    if (containsSensitiveCredential(text)) { notify("Credentials and secrets cannot be saved as memories.", "error"); return; }
    if (memoryInCloud && supabase && user) {
      const { error } = await supabase.from("memories").insert({ content: text, user_id: user.id });
      if (error) { notify(reportError("memory", error), "error"); return; }
      await loadCloudMemories();
      notify("Memory saved to your account.");
    } else {
      if (memories.length >= LOCAL_MEMORY_LIMIT) { notify(`This browser keeps up to ${LOCAL_MEMORY_LIMIT} memories. Delete one first.`, "error"); return; }
      const now = new Date().toISOString();
      saveLocalMemories([{ id: id(), text, createdAt: now, updatedAt: now, source: "you" }, ...memories]);
      notify("Memory saved in this browser.");
    }
    setMemoryText("");
  }

  async function editMemory(memoryId: string) {
    const target = memories.find((memory) => memory.id === memoryId);
    if (!target) return;
    const answer = await askFor({ title: "Edit memory", field: { label: "What FREYA remembers", value: target.text, placeholder: "", maxLength: 240 }, confirmLabel: "Save" });
    const text = typeof answer === "string" ? answer.replace(/\s+/g, " ").trim() : "";
    if (!text || text === target.text) return;
    if (containsSensitiveCredential(text)) { notify("Credentials and secrets cannot be saved as memories.", "error"); return; }
    if (memoryInCloud && supabase) {
      const { error } = await supabase.from("memories").update({ content: text, updated_at: new Date().toISOString() }).eq("id", memoryId);
      if (error) { notify(reportError("memory", error, "That memory could not be changed."), "error"); return; }
      await loadCloudMemories();
    } else {
      saveLocalMemories(memories.map((memory) => memory.id === memoryId ? { ...memory, text, updatedAt: new Date().toISOString() } : memory));
    }
    notify("Memory updated.");
  }

  async function deleteMemory(memoryId: string) {
    const target = memories.find((memory) => memory.id === memoryId);
    if (memoryInCloud && supabase) {
      const { error } = await supabase.from("memories").delete().eq("id", memoryId);
      if (error) { notify(reportError("memory", error, "That memory could not be deleted."), "error"); return; }
      await loadCloudMemories();
    } else saveLocalMemories(memories.filter((memory) => memory.id !== memoryId));
    // Never re-learned from an old conversation.
    if (target) rememberForgotten([target.text]);
    notify("Memory deleted. FREYA won't pick it up again from old chats.");
  }

  function patchConversation(conversationId: string, update: (messages: Message[]) => Message[]) {
    setConversations((previous) => previous.map((conversation) => conversation.id === conversationId
      ? { ...conversation, messages: update(conversation.messages), updatedAt: new Date().toISOString() }
      : conversation));
  }

  function syncReplying() {
    const ids = [activeJobRef.current?.conversationId, ...jobsRef.current.map((job) => job.conversationId)].filter(Boolean) as string[];
    setReplyingIn([...new Set(ids)]);
  }

  /**
   * Queues a reply. Messages sent while FREYA is busy wait their turn; several sent to the same
   * conversation meanwhile are answered together, in one reply to the latest of them.
   */
  function enqueueReply(job: ReplyJob) {
    // A reply still being thought about (nothing on screen yet) is called off and restarted
    // so it answers the whole burst. Once she has said something, the new message waits.
    const active = activeJobRef.current;
    if (!job.extraPrompt && !job.initiative && active && active.conversationId === job.conversationId
      && !active.extraPrompt && activePostedRef.current === 0) {
      activeChatRequest.current?.abort();
      jobsRef.current.unshift(job);
      syncReplying();
      return;
    }
    const waiting = job.extraPrompt || job.initiative ? undefined : jobsRef.current.find((queued) => queued.conversationId === job.conversationId && !queued.extraPrompt && !queued.initiative);
    // Combined only while it's a run of their messages: once FREYA has spoken after the waiting
    // one, the new message gets its own reply.
    const thread = conversationsRef.current.find((item) => item.id === job.conversationId)?.messages ?? [];
    const waitingAt = waiting ? thread.findIndex((message) => message.id === waiting.targetId) : -1;
    const interrupted = waitingAt >= 0 && thread.slice(waitingAt + 1).some((message) => message.role === "assistant");
    if (waiting && !interrupted) waiting.targetId = job.targetId;
    else jobsRef.current.push(job);
    syncReplying();
    void pumpReplies();
  }

  async function pumpReplies() {
    if (workerRef.current) return;
    workerRef.current = true;
    setLoading(true);
    try {
      for (let job = jobsRef.current[0]; job; job = jobsRef.current[0]) {
        // Give a burst ("hi" … "hello" … "you there?") a moment to finish before answering it.
        const sentAt = Date.parse(conversationsRef.current.find((item) => item.id === job!.conversationId)?.messages.find((message) => message.id === job!.targetId)?.at ?? "");
        const settle = BURST_MS - (Date.now() - sentAt);
        if (!job.initiative && !job.extraPrompt && settle > 0) { await delay(settle); continue; }
        jobsRef.current.shift();
        activeJobRef.current = job;
        activePostedRef.current = 0;
        syncReplying();
        // Read through the ref so each job runs with the settings current when it starts.
        await runReplyRef.current(job);
      }
    } finally {
      activeJobRef.current = null;
      workerRef.current = false;
      setLoading(false);
      setTypingIn("");
      setDeliberatingIn("");
      syncReplying();
    }
  }

  /** Drops a conversation's queued replies and stops the one running for it, if any. */
  function cancelRepliesFor(conversationId: string) {
    jobsRef.current = jobsRef.current.filter((job) => job.conversationId !== conversationId);
    if (activeJobRef.current?.conversationId === conversationId) activeChatRequest.current?.abort();
    syncReplying();
  }

  /** Unread count, a desktop notification and a toast, for replies landing out of view. */
  /**
   * Every message FREYA sends is announced: a chime (if on), a desktop notification when the
   * window isn't focused, an in-page banner when it lands out of sight, and an unread count
   * when it lands in a hidden tab or another conversation.
   */
  function announceReply(conversationId: string, message: Message, first: boolean) {
    const elsewhere = conversationId !== activeIdRef.current;
    const unfocused = document.hidden || !document.hasFocus();
    const preview = notificationPreview(message.content) || (message.spoken ? "Sent a voice message." : "Sent you something.");
    const title = conversationsRef.current.find((conversation) => conversation.id === conversationId)?.title ?? UNTITLED;
    if (soundRef.current) playChime();
    if (notificationsRef.current && (unfocused || elsewhere)) {
      showNotification(`FREYA · ${title}`, preview, `freya-${conversationId}`, () => selectConversation(conversationId));
    }
    if (!document.hidden && elsewhere && first) notify(`FREYA in “${title}”: ${preview}`);
    else if (!document.hidden && !elsewhere && !atBottomRef.current) notify(`FREYA: ${preview}`);
    if (!document.hidden && !elsewhere) return;
    setConversations((previous) => previous.map((conversation) => conversation.id === conversationId
      ? { ...conversation, unread: Math.min(99, (conversation.unread ?? 0) + 1) }
      : conversation));
  }

  /** The current turn's voice notes as audio FREYA can listen to (WAV only; newest two). */
  async function voiceAudio(turn: Message[]): Promise<WireAttachment[]> {
    const notes = turn.filter((message) => message.voice && AUDIO_MIMES.has(message.voice.mime)).slice(-2);
    const loaded = await Promise.all(notes.map(async (message): Promise<WireAttachment | null> => {
      const stored = await getAttachment(message.voice!.id);
      return stored?.data ? { name: "voice-note.wav", mime: message.voice!.mime, kind: "audio", data: stored.data } : null;
    }));
    return loaded.filter((item): item is WireAttachment => Boolean(item));
  }

  /** Attachment bytes for the current turn, read back from IndexedDB. */
  async function wireAttachments(items: AttachmentMeta[]): Promise<WireAttachment[]> {
    const wire = await Promise.all(items.map(async (item): Promise<WireAttachment> => {
      const stored = await getAttachment(item.id);
      return {
        name: item.name,
        mime: item.mime,
        kind: item.kind,
        ...(stored?.data && (item.kind === "image" || item.kind === "pdf" || item.kind === "audio") ? { data: stored.data } : {}),
        ...(stored?.text !== undefined ? { text: stored.text } : {}),
      };
    }));
    return wire;
  }

  /**
   * Gets one reply and posts it as a series of chat messages.
   *
   * The stream is cut into finished blocks (lib/reply-parts) and each is posted as its own
   * message once complete, paced like typing. The next queued reply starts only after every
   * part of this one has been posted.
   */
  async function runReply(job: ReplyJob) {
    // Let the render that added the user's message commit, so the snapshot includes it.
    await delay(0);
    const conversation = conversationsRef.current.find((item) => item.id === job.conversationId);
    const targetIndex = conversation?.messages.findIndex((message) => message.id === job.targetId) ?? -1;
    if (!conversation || targetIndex < 0) return;
    const target = conversation.messages[targetIndex];
    const initiative = Boolean(job.initiative);
    // Texting first answers nothing, so it carries no reply tag.
    const replyTo = initiative ? undefined : target.role === "user" ? target.id : target.replyTo;
    const turn = job.turn ?? id();
    const visible = conversation.messages.slice(0, targetIndex + 1);

    // FREYA reads a voice note as its transcript, and knows it was spoken.
    // FREYA reads a voice note as what was measured and said, and hears it on Gemini.
    const history = modelHistory(visible.map((message) => {
      const note = referenceNote(message, visible);
      const described = forModel(message);
      return note ? { ...described, content: `${note}\n\n${described.content}` } : described;
    }));
    if (job.extraPrompt) history.push({ role: "user", content: job.extraPrompt, attachments: [] });
    if (initiative) history.push({ role: "user", content: "[No new message from them. You are choosing to text first.]", attachments: [] });
    const { turns, older, sent } = requestTurns(history);
    if (!turns.length || turns[turns.length - 1].role !== "user") return;
    const latestUserText = [...visible].reverse().find((message) => message.role === "user")?.content ?? "";
    // Voice is answered with voice, mostly; otherwise she sends the odd voice note anyway.
    // Only short prose goes as voice: code, files, pictures and long answers stay as text.
    const lastAnswer = visible.map((message) => message.role).lastIndexOf("assistant");
    const answeringVoice = visible.slice(lastAnswer + 1).some((message) => message.voice);
    let voiceTurn = !job.extraPrompt && Math.random() < (answeringVoice ? 0.85 : 0.12);
    // Essays, letters and stories arrive as one typed-out piece; everything else is texted.
    let longform = !initiative && !job.extraPrompt && wantsLongForm(latestUserText);
    let postedChars = 0;
    let spokenChars = 0;

    // FREYA has now read everything up to the message she is answering.
    patchConversation(job.conversationId, (messages) => messages.map((message, index) =>
      (message.queued || message.failed) && index <= targetIndex ? { ...message, queued: false, failed: false } : message));
    setTypingIn(job.conversationId);
    // Same rule the route uses, so the label only shows when the panel really runs.
    if (!initiative && !privacyMode && needsReasoning(latestUserText, serverSetup.reasoning)) setDeliberatingIn(job.conversationId);
    const controller = new AbortController();
    activeChatRequest.current = controller;
    beginStream(latestUserText);
    window.dispatchEvent(new Event("freya:stop-listening"));

    const posted: string[] = [];
    let provider = "";
    let delivery = Promise.resolve();
    let lastPostedAt = performance.now();
    /** When she's busy she picks up later, and isn't shown typing until she does. */
    let pickUpAt = 0;
    const postBubble = (text: string) => {
      const first = posted.length === 0 && !job.turn;
      delivery = delivery.then(async () => {
        if (first && pickUpAt > performance.now()) {
          await delay(pickUpAt - performance.now());
          if (controller.signal.aborted) return;
          setTypingIn(job.conversationId);
          lastPostedAt = performance.now();
        }
        const wait = bubbleDelay(text, posted.length > 0) - (performance.now() - lastPostedAt);
        if (wait > 0) await delay(wait);
        if (controller.signal.aborted) return;
        // A reply that turns out long switches to text for the rest: nobody wants five minutes of voice notes.
        if (voiceTurn && spokenChars + text.length > 900) voiceTurn = false;
        const spoken = voiceTurn && speakable(text);
        if (spoken) spokenChars += text.length;
        const message: Message = {
          id: id(), role: "assistant", content: text, turn, at: new Date().toISOString(),
          ...(replyTo ? { replyTo } : {}), ...(provider ? { provider } : {}), ...(spoken ? { spoken: true } : {}),
          ...(initiative ? { initiative: true } : {}),
        };
        posted.push(message.id);
        activePostedRef.current += 1;
        patchConversation(job.conversationId, (messages) => [...messages, message]);
        lastPostedAt = performance.now();
        announceReply(job.conversationId, message, first);
        if (job.conversationId === activeIdRef.current) react(reactionInReply(text));
      });
    };

    // Long-form: one message, typed out as it grows. A short lead-in before it and a short
    // sign-off after it are sent as ordinary messages. Each block waits one step before
    // joining the piece, so the last one can still turn out to be the sign-off.
    let bodyId = "";
    let bodyText = "";
    let bodyStarted = false;
    let introSent = false;
    let held = "";
    const appendBody = (text: string) => {
      bodyStarted = true;
      delivery = delivery.then(async () => {
        if (controller.signal.aborted) return;
        bodyText = bodyText ? `${bodyText}\n\n${text}` : text;
        if (bodyId) {
          const content = bodyText;
          patchConversation(job.conversationId, (messages) => messages.map((message) => message.id === bodyId ? { ...message, content } : message));
          return;
        }
        const wait = 600 - (performance.now() - lastPostedAt);
        if (wait > 0) await delay(wait);
        const message: Message = {
          id: id(), role: "assistant", content: bodyText, turn, at: new Date().toISOString(), longform: true, streaming: true,
          ...(replyTo ? { replyTo } : {}), ...(provider ? { provider } : {}),
        };
        bodyId = message.id;
        posted.push(message.id);
        activePostedRef.current += 1;
        patchConversation(job.conversationId, (messages) => [...messages, message]);
        lastPostedAt = performance.now();
        announceReply(job.conversationId, message, posted.length === 1 && !job.turn);
      });
    };
    const post = (raw: string) => {
      // The fine-tuned model may still write the old hidden tag; it's removed and ignored.
      const { text, reaction: herReaction } = extractHerReaction(extractMoodTag(raw).text);
      if (herReaction && target.role === "user") patchConversation(job.conversationId, (messages) => messages.map((message) => message.id === target.id ? { ...message, herReaction } : message));
      if (!text) return;
      // A reply that turns out substantial (a structured explanation, or simply long) becomes one
      // document from here on, rather than a stack of bubbles. What's already sent stays.
      if (!longform && !initiative && becomesLongForm(text, postedChars)) longform = true;
      if (!longform) { postedChars += text.length; chopCasually(text).forEach(postBubble); return; }
      if (!bodyStarted && !introSent && !held && isAside(text)) { introSent = true; postBubble(text); return; }
      if (held) appendBody(held);
      held = text;
    };
    const finishPiece = async () => {
      if (held) {
        if (isAside(held)) postBubble(held);
        else appendBody(held);
        held = "";
      }
      await delivery;
      if (bodyId) patchConversation(job.conversationId, (messages) => messages.map((message) => message.id === bodyId ? { ...message, streaming: false } : message));
    };

    let buffer = "";
    let received = "";
    let truncated = false;
    let sources: Source[] = [];
    let reasoned: string[] = [];
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const attachments = [...await wireAttachments(sent), ...await voiceAudio(visible.slice(lastAnswer + 1))].slice(-MAX_ATTACHMENTS);
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          messages: turns.map((entry, index) => index === turns.length - 1 && attachments.length ? { ...entry, attachments } : entry),
          useMemories: memoryEnabled,
          // Without an account the notes live here, so they travel with the request.
          // Her other conversations, as chapters of the same relationship (lib/chapters).
          ...(memoryEnabled ? continuityOf(conversationsRef.current, job.conversationId, latestUserText) : {}),
          ...(memoryEnabled && !memoryInCloud && memories.length ? { localMemories: memories.map((memory) => ({ id: memory.id, text: memory.text, createdAt: memory.createdAt })) } : {}),
          style,
          characterProfile,
          privacyMode,
          autonomyLevel,
          candidLanguage,
          mood: moodRef.current,
          initiative,
          intimateMode,
          stayInCharacter,
          historySummary: summarizeOlderMessages(older),
          stream: true,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Request failed (${response.status}).`);
      }
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("application/json")) {
        // Short answers the route settles itself (time zones, search switched off) arrive whole.
        const payload = await response.json().catch(() => ({}));
        if (typeof payload.reply !== "string") throw new Error("The server returned an unreadable reply.");
        recordChunk(payload.reply);
        received = buffer = payload.reply;
        if (Array.isArray(payload.sources)) sources = payload.sources;
      } else if (response.body && type.includes("text/event-stream")) {
        await readReplyStream(response.body, controller.signal, {
          onMeta: (found, searchStatus, panel, herBusy) => {
            recordMeta(found.length, searchStatus); sources = found; reasoned = panel; setDeliberatingIn("");
            if (herBusy && (switches.realisticTiming ?? realisticTiming) && !initiative && !job.extraPrompt && !job.turn) { pickUpAt = performance.now() + busyDelay(); setTypingIn(""); }
          },
          onProvider: (name) => { recordProvider(name); provider = name; },
          onDelta: (delta) => {
            recordChunk(delta);
            received += delta;
            const { parts, rest } = takeCompleteParts(buffer + delta);
            buffer = rest;
            parts.forEach(post);
          },
          onDone: (done) => { truncated = Boolean(done?.truncated); },
          onError: (message) => { throw new Error(message); },
        });
      } else {
        throw new Error("The server did not return a readable reply stream.");
      }
      takeCompleteParts(buffer, true).parts.forEach(post);
      buffer = "";
      if (!received.trim()) throw new Error("The server returned an empty reply. Try again.");
      finishStream(truncated);
      await finishPiece();
      // Her own feelings: a mood she reported, and one more unanswered text if she went first.
      if (initiative) setMood((current) => ({ ...current, unprompted: current.unprompted + 1 }));
      // The provider is only known for sure once the stream ends; sources go under the last part.
      const lastPart = posted[posted.length - 1];
      patchConversation(job.conversationId, (messages) => messages.map((message) => posted.includes(message.id)
        ? { ...message, ...(provider ? { provider } : {}), ...(message.id === lastPart && sources.length ? { sources } : {}), ...(message.id === lastPart && reasoned.length ? { reasoned } : {}) }
        : message));
      setTruncatedReplyId(truncated && lastPart ? lastPart : "");
      if (latestUserText && !job.extraPrompt && !initiative) void autoSaveExplicitPreference(latestUserText);
      if (!job.turn && !initiative && user && autonomyLevel > 0) void reflectOnConversation(visible, true);
      scheduleReflection(job.conversationId);
    } catch (error) {
      failStream(controller.signal.aborted);
      if (controller.signal.aborted) return;
      // What already arrived is real and stays; a reply cut off mid-way can be retried.
      takeCompleteParts(buffer, true).parts.forEach(post);
      await finishPiece();
      // Nothing arrived: the message itself failed, and gets a Resend button.
      if (!posted.length && !initiative && target.role === "user") patchConversation(job.conversationId, (messages) => messages.map((message) => message.id === target.id ? { ...message, failed: true } : message));
      // These say what actually happened, so they're shown as they are.
      const reason = error instanceof Error && (error.message === PRIVATE_VOICE_DOWN || error.message.startsWith("Chat request limit reached")) ? error.message : undefined;
      notify(reportError("chat", error, reason), "error");
    } finally {
      if (activeChatRequest.current === controller) activeChatRequest.current = null;
      setTypingIn("");
      setDeliberatingIn("");
    }
  }
  useEffect(() => { runReplyRef.current = runReply; });
  useEffect(() => { memoriesRef.current = memories; }, [memories]);

  // Between conversations: once after loading, catch up on the most recent conversation left
  // unread; and whenever the tab is hidden, remember what mattered in the open one.
  useEffect(() => {
    if (!hydrated) return;
    const timers = reflectTimersRef.current;
    const catchUp = window.setTimeout(() => {
      const pending = [...conversationsRef.current]
        .filter((conversation) => conversation.messages.length > (conversation.reflectedCount ?? 0))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (pending) reflectRef.current(pending.id);
    }, 15_000);
    const onHidden = () => { if (document.hidden) reflectRef.current(activeIdRef.current); };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.clearTimeout(catchUp);
      document.removeEventListener("visibilitychange", onHidden);
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, [hydrated]);

  /** How a message from them lands on her: mood, and sometimes a new thing to wonder about. */
  function feel(text: string) {
    setMood((current) => {
      let next = reactToMessage(resumeMood(current), text, Date.now(), { intimate: intimateMode && switches.sexTalk !== false });
      const words = contentWords(text).filter((word) => word.length >= 6);
      if (words.length && Math.random() < 0.35) next = addCuriosity(next, words[Math.floor(Math.random() * words.length)]);
      return next;
    });
  }

  function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if ((!text && !pendingFiles.length) || preparingFiles > 0) return;
    if (!pendingFiles.length) {
      const command = parseCommand(text);
      if (command) {
        if (!command.argument) { notify(command.name === "visualize" ? "Say what to show, e.g. /visualize a red fox." : "Say what to draw, e.g. /image a lighthouse at night.", "error"); return; }
        setInput("");
        setReplyingToId("");
        setRefiningId("");
        if (command.name === "visualize") void runVisualize(command.argument);
        else void runPicture(command.argument, command.argument);
        return;
      }
      // With a canvas tagged, what they type is the change to make to it.
      if (refineTarget) { setInput(""); setRefiningId(""); void runRefine(text, refineTarget); return; }
      const subject = pictureRequest(text);
      if (subject) { setInput(""); setReplyingToId(""); void runPicture(subject, text); return; }
    }
    const message: Message = {
      id: id(), role: "user", content: text, at: new Date().toISOString(),
      ...(pendingFiles.length ? { attachments: pendingFiles } : {}),
      ...(replyingToId ? { replyTo: replyingToId } : {}),
      // Shown as "queued" until FREYA finishes what she is sending now.
      ...(workerRef.current ? { queued: true } : {}),
    };
    updateActiveMessages((previous) => [...previous, message]);
    feel(text);
    react(reactionTo(text));
    setInput("");
    setReplyingToId("");
    setPendingFiles([]);
    setTruncatedReplyId("");
    shouldAutoScroll.current = true;
    atBottomRef.current = true;
    setAtBottom(true);
    enqueueReply({ conversationId: activeIdRef.current, targetId: message.id });
  }

  /** Adds a command chip and FREYA's card to the open conversation; returns the card's id. */
  function postCommand(kind: "visualize" | "image", shown: string, card: Partial<Message>) {
    const at = new Date().toISOString();
    const cardId = id();
    updateActiveMessages((previous) => [...previous,
      { id: id(), role: "user", content: shown, at, command: kind },
      { id: cardId, role: "assistant", content: "", at, ...card },
    ]);
    shouldAutoScroll.current = true;
    atBottomRef.current = true;
    setAtBottom(true);
    return { conversationId: activeIdRef.current, cardId };
  }

  function patchMessage(conversationId: string, messageId: string, patch: Partial<Message>) {
    patchConversation(conversationId, (messages) => messages.map((message) => message.id === messageId ? { ...message, ...patch } : message));
  }

  /** /visualize: the request goes to the visualisation route; the result lands on the canvas. */
  async function runVisualize(description: string) {
    if (privacyMode) { notify("Visualisations need a cloud model, so they're paused in Local-only mode.", "error"); return; }
    const title = description.length > 40 ? `${description.slice(0, 40).trimEnd()}…` : description;
    const { conversationId, cardId } = postCommand("visualize", description, { visualization: { title, status: "loading" } });
    setCanvasForm({ key: cardId, title, status: "loading" });
    try {
      const response = await fetch("/api/visualize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description }) });
      const payload = await response.json().catch(() => ({}));
      const spec = validateSpec(payload?.spec);
      if (!response.ok || !spec) throw new Error(typeof payload?.error === "string" ? payload.error : "The visualisation couldn't be made.");
      const cloud = await cloudForSpec(spec, FORM_POINTS);
      patchMessage(conversationId, cardId, { visualization: { title: spec.title, status: "ready", spec } });
      // A newer request may own the canvas by now; only replace our own placeholder.
      setCanvasForm((shown) => shown?.key === cardId ? { key: cardId, title: spec.title, status: "ready", cloud } : shown);
    } catch (error) {
      const message = cardError(error, "The visualisation couldn't be made.");
      patchMessage(conversationId, cardId, { visualization: { title, status: "error", error: message } });
      setCanvasForm((shown) => shown?.key === cardId ? { key: cardId, title, status: "error" } : shown);
      reportError("visualize", error);
    }
  }

  async function showVisualization(message: Message) {
    const spec = message.visualization?.spec;
    if (!spec) return;
    try {
      setCanvasForm({ key: message.id, title: spec.title, status: "ready", cloud: await cloudForSpec(spec, FORM_POINTS) });
    } catch (error) { notify(reportError("visualize", error, "That form couldn't be shown."), "error"); }
  }

  /**
   * Changes the one form whose Refine button was used, and no other. It updates that form and its
   * card in place: no new card or canvas is made, and a failure leaves it as it was.
   */
  async function runRefine(change: string, target: Message) {
    if (privacyMode) { notify("Visualisations need a cloud model, so they're paused in Local-only mode.", "error"); return; }
    const before = target.visualization;
    if (!before?.spec) return;
    const conversationId = activeIdRef.current;
    const at = new Date().toISOString();
    updateActiveMessages((previous) => [...previous, { id: id(), role: "user", content: change, at, command: "refine", replyTo: target.id }]);
    shouldAutoScroll.current = true;
    atBottomRef.current = true;
    setAtBottom(true);
    patchMessage(conversationId, target.id, { visualization: { ...before, status: "loading", refining: true } });
    const restore = async () => ({ key: target.id, title: before.title, status: "ready" as const, cloud: canvasForm?.key === target.id && canvasForm.cloud ? canvasForm.cloud : await cloudForSpec(before.spec!, FORM_POINTS) });
    const shown = await restore();
    setCanvasForm({ ...shown, status: "refining" });
    try {
      const response = await fetch("/api/visualize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: change, mode: "refine", current: before.spec }) });
      const payload = await response.json().catch(() => ({}));
      const spec = validateSpec(payload?.spec);
      if (!response.ok || !spec) throw new Error(typeof payload?.error === "string" ? payload.error : "That change couldn't be made.");
      const cloud = await cloudForSpec(spec, FORM_POINTS);
      patchMessage(conversationId, target.id, { visualization: { title: spec.title, status: "ready", spec } });
      setCanvasForm((current) => current?.key === target.id ? { key: target.id, title: spec.title, status: "ready", cloud } : current);
    } catch (error) {
      patchMessage(conversationId, target.id, { visualization: before });
      setCanvasForm((current) => current?.key === target.id ? shown : current);
      notify(cardError(error, "That change couldn't be made."), "error");
      reportError("visualize", error);
    }
  }

  /** A picture in the chat: generated when an image model is available, else a labelled SVG. */
  async function runPicture(prompt: string, shown: string) {
    if (privacyMode) { notify("Pictures need a cloud model, so they're paused in Local-only mode.", "error"); return; }
    const last = refinesPrevious(prompt) ? [...messages].reverse().find((message) => message.picture?.status === "ready") : undefined;
    let previous: { prompt: string; mime?: string; data?: string } | undefined;
    if (last?.picture) {
      previous = { prompt: last.picture.prompt };
      const stored = last.picture.kind === "generated" && last.attachments?.[0] ? await getAttachment(last.attachments[0].id).catch(() => undefined) : undefined;
      if (stored?.data && last.attachments?.[0]) previous = { ...previous, mime: last.attachments[0].mime, data: stored.data };
    }
    const fullPrompt = previous ? `${previous.prompt}; ${prompt}` : prompt;
    const { conversationId, cardId } = postCommand("image", shown, { picture: { status: "loading", prompt: fullPrompt } });
    try {
      const response = await fetch("/api/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, ...(previous ? { previous } : {}) }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "That picture couldn't be made.");
      if (payload.kind === "generated" && typeof payload.data === "string" && typeof payload.mime === "string") {
        const bytes = Uint8Array.from(atob(payload.data), (character) => character.charCodeAt(0));
        const attachmentId = id();
        const prepared = await prepareAttachment(new File([bytes], `freya-picture.${payload.mime.split("/")[1] || "png"}`, { type: payload.mime }), attachmentId);
        await putAttachment(attachmentId, prepared.stored);
        patchMessage(conversationId, cardId, { attachments: [prepared.meta], picture: { status: "ready", kind: "generated", prompt: fullPrompt, model: String(payload.model || "") } });
      } else {
        const svg = sanitizeSvg(payload.svg);
        if (payload.kind !== "svg" || !svg) throw new Error("That picture couldn't be made.");
        patchMessage(conversationId, cardId, { picture: { status: "ready", kind: "svg", prompt: fullPrompt, svg, reason: String(payload.reason || "") } });
      }
    } catch (error) {
      patchMessage(conversationId, cardId, { picture: { status: "error", prompt: fullPrompt, error: cardError(error, "That picture couldn't be made.") } });
      reportError("image", error);
    }
  }

  function startRefine() {
    setInput("/image ");
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  /** The card's Refine button: tags that form in the composer and puts it on the canvas. */
  function tagForRefine(message: Message) {
    setRefiningId((current) => current === message.id ? "" : message.id);
    setReplyingToId("");
    if (canvasForm?.key !== message.id) void showVisualization(message);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function startReply(messageId: string) {
    setReplyingToId(messageId);
    setRefiningId("");
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  /** One reaction per message: picking the same one again takes it off. */
  function toggleReaction(message: Message, reaction: string) {
    const next = message.reaction === reaction ? undefined : reaction;
    patchConversation(activeIdRef.current, (messages) => messages.map((item) => item.id === message.id ? { ...item, reaction: next } : item));
    setReactingToId("");
    // A reaction is part of how the conversation is going, so it can move her mood like a message.
    if (next) feel(next);
  }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content || message.picture?.prompt || message.visualization?.title || "");
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((current) => current === message.id ? "" : current), 1200);
    } catch (error) { notify(reportError("copy", error, "That couldn't be copied."), "error"); }
  }

  /**
   * Saves an edit. Editing the latest thing they said means they want an answer to the new text,
   * so her reply to it is replaced. Editing further back only corrects the record: what followed
   * stays, and she reads the corrected version from now on.
   */
  function saveEdit(message: Message) {
    const text = editText.trim();
    setEditingId("");
    if (!text || text === message.content) return;
    const conversationId = activeIdRef.current;
    const index = messages.findIndex((item) => item.id === message.id);
    const isLatest = !messages.slice(index + 1).some((item) => item.role === "user" && !item.command);
    patchConversation(conversationId, (current) => current
      .filter((item, position) => !isLatest || position <= index || item.role !== "assistant" || item.visualization || item.picture)
      .map((item) => item.id === message.id ? { ...item, content: text, edited: true, failed: false } : item));
    // Automatic memory reads it again, and a chat named after this message follows the change.
    setConversations((previous) => previous.map((conversation) => conversation.id === conversationId ? {
      ...conversation,
      reflectedCount: Math.min(conversation.reflectedCount ?? 0, index),
      title: conversation.title === deriveTitle(message.content) ? deriveTitle(text) : conversation.title,
    } : conversation));
    if (isLatest) enqueueReply({ conversationId, targetId: message.id });
  }

  async function addFiles(list: FileList | File[] | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const room = MAX_ATTACHMENTS - pendingFiles.length - preparingFiles;
    if (room <= 0) { notify(`Up to ${MAX_ATTACHMENTS} attachments per message.`, "error"); return; }
    if (files.length > room) notify(`Only ${room} more attachment${room === 1 ? "" : "s"} fit in this message.`, "info");
    const accepted = files.slice(0, room);
    setPreparingFiles((count) => count + accepted.length);
    for (const file of accepted) {
      try {
        const attachmentId = id();
        const prepared = await prepareAttachment(file, attachmentId);
        await putAttachment(attachmentId, prepared.stored);
        setPendingFiles((current) => [...current, prepared.meta].slice(0, MAX_ATTACHMENTS));
      } catch (error) {
        notify(error instanceof AttachmentError ? error.message : reportError("attachment", error, `${file.name || "That file"} could not be attached.`), "error");
      } finally {
        setPreparingFiles((count) => count - 1);
      }
    }
    composerRef.current?.focus();
  }

  function removePendingFile(attachmentId: string) {
    setPendingFiles((current) => current.filter((item) => item.id !== attachmentId));
    void deleteAttachments([attachmentId]);
  }

  /** Turning adult roleplay on needs an explicit 18+ confirmation; turning it off doesn't. */
  async function toggleIntimateMode(enabled: boolean) {
    if (!enabled) { setIntimateMode(false); return; }
    const confirmed = await askFor({
      title: "Turn on intimate roleplay?",
      body: `FREYA can sext and take part in fully explicit roleplay when you lead there, and when she's in a playful mood she may start it herself. Confirm only if you are 18 or older. ${serverSetup.voiceOnThisMachine ? "Those conversations are written by your local Ollama model and stay on this machine." : "Those conversations are written by the voice server you set up, so they leave this machine and pass through that server and its tunnel. They never go to Groq or Gemini."} Nothing involving minors, non-consent, or real people, ever.`,
      confirmLabel: "I'm 18+, turn on",
    });
    if (confirmed) setIntimateMode(true);
  }

  async function toggleNotifications(enabled: boolean) {
    if (!enabled) { setNotificationsOn(false); return; }
    const state = await requestNotifications();
    if (state === "granted") { setNotificationsOn(true); notify("Notifications on. FREYA will alert you when a reply lands out of view."); }
    else if (state === "unsupported") notify("This browser does not support notifications. Unread counts still show in the list.", "error");
    else notify("Notifications are blocked for this site. Allow them in the browser's site settings.", "error");
  }

  /** Ask for the rest of a reply that ran out of continuation budget mid-thought. */
  function continueReply() {
    if (loading) return;
    const target = messages.find((message) => message.id === truncatedReplyId);
    if (!target) return;
    setTruncatedReplyId("");
    enqueueReply({ conversationId: activeIdRef.current, targetId: target.id, turn: turnOf(target), extraPrompt: "Continue from exactly where you stopped. Do not repeat anything." });
  }

  /** Ask again for a message that failed, or that never got a reply. */
  function resendMessage(messageId: string) {
    patchConversation(activeIdRef.current, (current) => current.map((message) => message.id === messageId ? { ...message, failed: false } : message));
    enqueueReply({ conversationId: activeIdRef.current, targetId: messageId });
  }

  /**
   * A recorded voice note. It is always sent, even with no words in it: silence and noise are
   * messages too. The audio goes to FREYA as sound (she listens on Gemini) and as a transcript
   * when there are words. Silence is measured from the samples, not guessed from the text.
   */
  async function sendVoice(recording: Blob, seconds: number) {
    if (privacyMode) { notify("Voice messages are heard by the cloud provider, so they are off in Local-only mode.", "error"); return; }
    const conversationId = activeIdRef.current;
    setTranscribing(true);
    try {
      let audio: string;
      let mime = "audio/wav";
      let silent = false;
      let length = seconds;
      try {
        const prepared = await prepareVoice(recording);
        audio = prepared.base64;
        silent = prepared.analysis.silent;
        length = prepared.analysis.seconds;
      } catch {
        // A browser that cannot decode its own recording still sends it, untouched.
        mime = (recording.type || "audio/webm").split(";")[0];
        audio = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
          reader.onerror = () => reject(reader.error ?? new Error("Recording could not be read."));
          reader.readAsDataURL(recording);
        });
      }
      // Whisper invents words for silence ("Thank you."), so silent notes skip it entirely.
      let transcript = "";
      if (!silent) {
        const response = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio, mime }),
        }).catch(() => null);
        const payload = await response?.json().catch(() => ({}));
        if (response?.ok && typeof payload?.text === "string") transcript = payload.text;
      }
      const audioId = id();
      await putAttachment(audioId, { data: audio });
      const message: Message = {
        id: id(), role: "user", content: transcript,
        at: new Date().toISOString(), voice: { id: audioId, mime, seconds: length, ...(silent ? { silent: true } : {}) },
        ...(workerRef.current ? { queued: true } : {}),
      };
      patchConversation(conversationId, (current) => [...current, message]);
      feel(transcript);
      shouldAutoScroll.current = true;
      atBottomRef.current = true;
      setAtBottom(true);
      enqueueReply({ conversationId, targetId: message.id });
    } catch (error) {
      notify(reportError("voice", error, "That voice message could not be sent."), "error");
    } finally {
      setTranscribing(false);
    }
  }

  function jumpToMessage(messageId: string) {
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    element.classList.add("flash");
    window.setTimeout(() => element.classList.remove("flash"), 1400);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && (replyingToId || refiningId)) { event.preventDefault(); setReplyingToId(""); setRefiningId(""); return; }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  // Workspace shortcuts: new conversation, sidebar toggle, and jump to the composer.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const typing = document.activeElement instanceof HTMLElement
        && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
      if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); newConversation(); return; }
      if (modifier && event.key.toLowerCase() === "b") { event.preventDefault(); setDrawerOpen((open) => !open); return; }
      if (event.key === "Escape" && !settingsOpen && window.innerWidth <= 700) { setDrawerOpen(false); return; }
      if (event.key === "/" && !typing && !settingsOpen) { event.preventDefault(); composerRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newConversation, settingsOpen]);

  async function clearAllMemories() {
    const location = memoryInCloud ? "your account" : "this browser";
    const confirmed = await askFor({
      title: "Forget everything?",
      body: `All ${memories.length} memories kept in ${location} will be deleted, and FREYA won't re-learn them from your existing conversations. Your conversations themselves are kept. This cannot be undone.`,
      confirmLabel: "Forget everything",
      destructive: true,
    });
    if (!confirmed) return;
    if (memoryInCloud && supabase && user) {
      const { error } = await supabase.from("memories").delete().eq("user_id", user.id);
      if (error) { notify(reportError("memory", error, "Those memories could not be deleted."), "error"); return; }
      setMemories([]);
    } else {
      saveLocalMemories([]);
    }
    rememberForgotten(memories.map((memory) => memory.text));
    // Everything said so far counts as read, so nothing deleted comes back from an old chat.
    setConversations((previous) => previous.map((conversation) => {
      const kept: Conversation = { ...conversation, reflectedCount: conversation.messages.length };
      delete kept.recap;
      return kept;
    }));
    try { localStorage.setItem(MEMORY_RESET_KEY, new Date().toISOString()); } catch { /* the notes themselves are gone */ }
    notify(`All memories were deleted from ${location}.`);
  }

  const canvasSignal: CanvasSignal = loading
    ? "generating"
    : input.trim()
      ? "composing"
      : messages.at(-1)?.role === "assistant"
        ? "responding"
        : "idle";
  const latestUserText = [...messages].reverse().find((message) => message.role === "user")?.content || "";
  const latestAssistantText = [...messages].reverse().find((message) => message.role === "assistant")?.content || "";
  const remainingChars = MAX_INPUT_CHARS - input.length;
  const thread = useMemo(() => describeThread(messages), [messages]);
  const replyingHere = replyingIn.includes(activeId);
  // Her face: a fresh reaction first, then thinking while she works out a reply, then her mood.
  const portraitExpression = chooseExpression(mood.name, typingIn === activeId && Boolean(typingIn), reaction);
  // A command chip (a refinement with no card after it) isn't waiting for an answer.
  // Nor is a message she answered with just a reaction.
  const awaitingReply = hydrated && !replyingHere && messages.at(-1)?.role === "user" && !messages.at(-1)?.command && !messages.at(-1)?.herReaction;
  const replyTarget = replyingToId ? messages.find((message) => message.id === replyingToId) : undefined;
  const refineTarget = refiningId ? messages.find((message) => message.id === refiningId && message.visualization?.spec) : undefined;


  return (
    <main className={`app-shell ${drawerOpen ? "drawer-open" : ""}`}>
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
      <AskDialog request={ask} onResolve={resolveAsk} />
      <header className="global-menu-bar">
        <button type="button" className="menu-trigger" onClick={() => setDrawerOpen(!drawerOpen)} aria-expanded={drawerOpen} aria-controls="freya-sidebar" title="Toggle conversations (Ctrl/⌘ + B)"><span className="menu-glyph">☰</span><span>CHATS</span>{totalUnread > 0 && <span className="menu-unread" aria-label={`${totalUnread} unread`}>{totalUnread}</span>}</button>
        <div className="global-wordmark">FREYA</div>
        <button type="button" className="account-trigger" onClick={() => { setSettingsTab("profile"); setSettingsOpen(true); }} aria-label="Open profile and settings" aria-expanded={settingsOpen}>⚙</button>
      </header>

      {settingsOpen && <div className="settings-dialog-layer">
        <button className="settings-dialog-backdrop" type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)} />
        <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" ref={dialogRef}>
          <header className="settings-dialog-header">
            <div><span className="settings-kicker">FREYA CONTROL PANEL</span><h2 id="settings-dialog-title">Profile &amp; settings</h2></div>
            <button type="button" className="settings-close" onClick={() => setSettingsOpen(false)} aria-label="Close profile and settings">×</button>
          </header>
          <div className="settings-tabs" role="tablist" aria-label="Profile and settings">
            <button type="button" id="profile-tab" role="tab" aria-selected={settingsTab === "profile"} aria-controls="profile-tab-panel" className={settingsTab === "profile" ? "selected" : ""} onClick={() => setSettingsTab("profile")}>PROFILE</button>
            <button type="button" id="settings-tab" role="tab" aria-selected={settingsTab === "settings"} aria-controls="settings-tab-panel" className={settingsTab === "settings" ? "selected" : ""} onClick={() => setSettingsTab("settings")}>SETTINGS</button>
          </div>
          <div className="settings-dialog-content">
            {settingsTab === "profile" ? <div id="profile-tab-panel" role="tabpanel" aria-labelledby="profile-tab" className="settings-tab-panel">
              <div className="profile-summary"><div className="profile-monogram">F</div><div><strong>FREYA, 20</strong><span>{user ? user.email : "Anonymous session"}</span></div></div>
              <p className="settings-description">Edit FREYA&apos;s fictional character dossier. These tastes are separate from your saved memories.</p>
              <CharacterProfileEditor
                profile={characterProfile}
                onChange={setCharacterProfile}
                revisions={profileRevisions}
                proposals={personalityProposals}
                canReflect={Boolean(user) && cloudProfileAvailable && autonomyLevel > 0}
                onRollback={(revision) => void rollbackProfile(revision)}
                onReview={(proposalId, decision) => void reviewProposal(proposalId, decision)}
                onReflect={() => void reflectOnConversation()}
              />
              {supabase && <div className="settings-account-block">{user ? <><p className="memory-description">Cloud memories are scoped to this signed-in account.</p><button className="small-primary" type="button" onClick={() => void signOut()}>Sign out</button></> : <><div className="side-label">CLOUD MEMORY ACCOUNT</div><p className="memory-description">Sign in to sync personal memories.</p><form className="memory-form" onSubmit={(event) => void submitAuth("signin", event)}><input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="Email" autoComplete="email" required/><input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Password (min. 6 chars)" autoComplete="current-password" minLength={6} required/><button className="small-primary" type="submit" disabled={authBusy}>{authBusy ? "Please wait…" : "Sign in"}</button><button className="clear-memories" type="button" disabled={authBusy} onClick={() => void submitAuth("signup")}>Create account</button></form></>}</div>}
            </div> : <div id="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab" className="settings-tab-panel">
              <div className="settings-group-title">CONVERSATION</div>
              {Object.keys(switches).length > 0 && <p className="settings-description">Greyed-out switches are set in freya.config.json. Run freya to change them.</p>}
              <div className="dialog-setting-row"><div><strong>Reply style</strong><span>Choose FREYA&apos;s conversational tone.</span></div><select value={style} onChange={(event) => setStyle(event.target.value as Style)} aria-label="Reply style"><option value="adaptive">Adaptive</option><option value="friendly">Friendly</option><option value="direct">Direct</option><option value="professional">Professional</option><option value="playful">Playful</option></select></div>
              <div className="dialog-setting-row"><div><strong>Candid language</strong><span>She swears a lot and trash-talks you when you&apos;ve earned it. No slurs or threats, and none of it when you&apos;re hurting.</span></div><label className="toggle-row"><span className="sr-only">Candid language</span><input type="checkbox" checked={switches.swearing ?? candidLanguage} disabled={switches.swearing !== undefined} onChange={(event) => setCandidLanguage(event.target.checked)} /></label></div>
              <div className="dialog-setting-row"><div><strong>Stay in character</strong><span>I know Freya is an AI, don&apos;t remind me. If you ask, she dodges instead of answering, and she never says she&apos;s human. She still tells you the truth if you&apos;re upset, getting attached, or say &ldquo;drop the act&rdquo;.</span></div><label className="toggle-row"><span className="sr-only">Stay in character</span><input type="checkbox" checked={switches.stayInCharacter ?? stayInCharacter} disabled={switches.stayInCharacter !== undefined} onChange={(event) => setStayInCharacter(event.target.checked)} /></label></div>
              <div className="dialog-setting-row"><div><strong>Realistic timing</strong><span>When she&apos;s at work or in a lecture, her first reply can take up to a minute.</span></div><label className="toggle-row"><span className="sr-only">Realistic timing</span><input type="checkbox" checked={switches.realisticTiming ?? realisticTiming} disabled={switches.realisticTiming !== undefined} onChange={(event) => setRealisticTiming(event.target.checked)} /></label></div>
              <div className="dialog-setting-row"><div><strong>FREYA texts first</strong><span>She may message you after you&apos;ve been quiet a while, at most twice without a reply. Off at autonomy level 0. Only while FREYA is open in a tab.</span></div><label className="toggle-row"><span className="sr-only">FREYA texts first</span><input type="checkbox" checked={switches.textsFirst ?? initiativeOn} disabled={switches.textsFirst !== undefined} onChange={(event) => setInitiativeOn(event.target.checked)} /></label></div>
              <div className="dialog-setting-row"><div><strong>Autonomy</strong><span>How much she does on her own: texting first, and suggesting new tastes for her profile.</span></div><select value={autonomyLevel} onChange={(event) => setAutonomyLevel(Number(event.target.value) as 0 | 1 | 2)} aria-label="Autonomy level"><option value={0}>Level 0 · Reply only</option><option value={1}>Level 1 · Propose for approval</option><option value={2}>Level 2 · Approve tentative interests</option></select></div>
              <div className="dialog-setting-row"><div><strong>Intimate roleplay (18+)</strong><span>Sexting and adult roleplay when you lead there, or when she&apos;s in a playful mood; she switches back to normal chat when you do. {serverSetup.voiceOnThisMachine ? "Those turns run on your local Ollama model." : "Those turns run on your voice server, never on Groq or Gemini."}</span></div><label className="toggle-row"><span className="sr-only">Intimate roleplay</span><input type="checkbox" checked={intimateMode && switches.sexTalk !== false} disabled={switches.sexTalk === false} onChange={(event) => void toggleIntimateMode(event.target.checked)} /></label></div>
              <div className="settings-group-title">MEMORY</div>
              <div className="dialog-setting-row"><div><strong>Use memories in replies</strong><span>FREYA brings up what she remembers about you when it&apos;s relevant.</span></div><label className="toggle-row"><span className="sr-only">Use memories in replies</span><input type="checkbox" checked={memoryEnabled} onChange={(event) => setMemoryEnabled(event.target.checked)} /></label></div>
              <div className="dialog-setting-row"><div><strong>Remember things automatically</strong><span>After a conversation goes quiet, or when you switch chats, a cloud model reads what&apos;s new and keeps what matters: people, plans, preferences, things to follow up. Small talk isn&apos;t kept. In Local-only mode only explicit &ldquo;I prefer…&rdquo; statements are saved.</span></div><label className="toggle-row"><span className="sr-only">Remember things automatically</span><input type="checkbox" checked={autoMemory} onChange={(event) => setAutoMemory(event.target.checked)} /></label></div>
              <button className={`side-action dialog-action ${memoryOpen ? "active" : ""}`} onClick={() => setMemoryOpen(!memoryOpen)} aria-expanded={memoryOpen}>◈ <span>What FREYA remembers</span><span className="count">{memories.length}</span></button>
              {memoryOpen && <div className="memory-panel dialog-memory-panel">
                <p className="memory-description">{memoryInCloud ? "Synced to your account: only you can see them, on any device you sign in on." : `Kept in this browser only${supabase ? "; sign in under Profile to sync them to your account" : ""}. Clearing this site's data deletes them.`}</p>
                <form onSubmit={addMemory} className="memory-form"><textarea value={memoryText} onChange={(event) => setMemoryText(event.target.value)} placeholder="Tell her something to remember, e.g. I prefer short answers" maxLength={240} rows={2} aria-label="New memory"/><button className="small-primary" type="submit">Save memory</button></form>
                {memories.length === 0
                  ? <p className="empty-memories">Nothing yet. {autoMemory ? "She'll pick things up as you talk" : "Turn on automatic memory, or add one above"}.</p>
                  : <ul className="memory-list" aria-label="Saved memories">{memories.map((memory) => <li className="memory-item" key={memory.id}>
                    <span>{memory.text}<small className="memory-meta">{[memory.source === "freya" ? "noticed by FREYA" : memory.source === "you" ? "added by you" : "", memory.kind && memory.kind !== "other" ? memory.kind : "", formatRelative(memory.updatedAt || memory.createdAt).toLowerCase()].filter(Boolean).join(" · ")}</small></span>
                    <button type="button" aria-label={`Edit memory: ${memory.text}`} title="Edit" onClick={() => void editMemory(memory.id)}>✎</button>
                    <button type="button" aria-label={`Delete memory: ${memory.text}`} title="Delete" onClick={() => void deleteMemory(memory.id)}>×</button>
                  </li>)}</ul>}
                {memories.length > 0 && <button className="clear-memories" onClick={clearAllMemories}>Forget everything</button>}
              </div>}
              <div className="settings-group-title">NOTIFICATIONS</div>
              <div className="dialog-setting-row"><div><strong>Notifications</strong><span>A desktop alert for every FREYA message while you are in another window or tab, or another chat is open. Unread counts show in the conversation list either way.</span></div><label className="toggle-row"><span className="sr-only">Notifications</span><input type="checkbox" checked={notificationsOn} onChange={(event) => void toggleNotifications(event.target.checked)} /></label></div>
              <div className="dialog-setting-row"><div><strong>Message sound</strong><span>A soft chime whenever FREYA sends a message.</span></div><label className="toggle-row"><span className="sr-only">Message sound</span><input type="checkbox" checked={soundOn} onChange={(event) => { setSoundOn(event.target.checked); if (event.target.checked) playChime(); }} /></label></div>
              
              <div className="settings-group-title">PRIVACY &amp; DATA</div>
              <div className="dialog-setting-row"><div><strong>Local-only privacy</strong><span>{serverSetup.voiceOnThisMachine ? <>Every reply comes from the local model on this computer{serverSetup.localModel ? ` (${serverSetup.localModel}${serverSetup.localReady ? "" : ", not running"})` : " (none found)"}; nothing is sent to cloud models. Automatic memory, images and visualisations pause.</> : "Needs her model on this computer, and right now it's on your voice server. Run start.bat --local to switch back."}</span></div><label className="toggle-row"><span className="sr-only">Local-only privacy</span><input type="checkbox" checked={privacyMode} onChange={(event) => setPrivacyMode(event.target.checked)} /></label></div>
              <div className="dialog-setting-row"><div><strong>Export</strong><span>Save the open conversation as a Markdown file.</span></div><button type="button" className="dialog-inline-button" onClick={exportActiveConversation}>Export chat</button></div>
              <div className="dialog-setting-row"><div><strong>Not her ({feedbackCount})</strong><span>Replies you marked with ⚑, and what she should have said. Put the file in training/data/ before the next fine-tune.</span></div><button type="button" className="dialog-inline-button" onClick={exportFeedback}>Export</button></div>
              <div className="shortcut-list"><div className="side-label">KEYBOARD</div><dl><dt>Ctrl / ⌘ + K</dt><dd>New conversation</dd><dt>Ctrl / ⌘ + B</dt><dd>Toggle conversation list</dd><dt>/</dt><dd>Focus the composer</dd><dt>Shift + Enter</dt><dd>New line</dd><dt>/visualize …</dt><dd>Make a new form on the canvas</dd><dt>/image …</dt><dd>Make a picture in the chat</dd></dl></div>
            </div>}
          </div>
        </section>
      </div>}

      <div className="workspace-grid">
        <aside id="freya-sidebar" className={`sidebar ${drawerOpen ? "mobile-open" : ""}`} aria-label="Conversations and settings">
          <div className="sidebar-title">CONVERSATIONS<span className="sidebar-count">{conversations.length}</span></div>
          <button className="new-chat" onClick={newConversation} title="New conversation (Ctrl/⌘ + K)">＋ <span>New conversation</span></button>
          {conversations.length > 4 && <input className="conversation-filter" type="search" value={conversationFilter} onChange={(event) => setConversationFilter(event.target.value)} placeholder="Filter conversations" aria-label="Filter conversations"/>}
          <div className="conversation-scroll">
            {visibleConversations.length === 0
              ? <p className="conversation-empty">No conversation matches that filter.</p>
              : visibleConversations.map((conversation) => <div key={conversation.id} className={`conversation-row ${conversation.id === activeId ? "active" : ""}`}>
                <button className="conversation-item" onClick={() => selectConversation(conversation.id)} aria-current={conversation.id === activeId} onDoubleClick={() => renameConversation(conversation.id)} title={conversation.title}>
                  <span className={`conversation-status ${replyingIn.includes(conversation.id) ? "typing" : ""}`} aria-hidden="true"/>
                  <span className="conversation-label">{conversation.title}</span>
                  {conversation.unread
                    ? <span className="conversation-unread" aria-label={`${conversation.unread} unread`}>{conversation.unread}</span>
                    : <span className="conversation-meta">{conversation.messages.length ? formatRelative(conversation.updatedAt) : "—"}</span>}
                </button>
                <button className="conversation-delete" onClick={() => deleteConversation(conversation.id)} aria-label={`Delete conversation: ${conversation.title}`} title="Delete conversation">×</button>
              </div>)}
          </div>
          <div className="sidebar-footer"><span className="status-dot"/> <span>{memoryInCloud ? "Memories synced to your account" : "Memories kept in this browser"}</span><div>v0.5</div></div>
        </aside>
        {drawerOpen && <button className="drawer-backdrop" type="button" aria-label="Close conversation drawer" onClick={() => setDrawerOpen(false)}/>}

        <section className="main-panel">
          <div className="center-status-bar">
            <span className="status-name">FREYA</span>
            <span className="status-separator" aria-hidden="true">·</span>
            <span className="status-presence" aria-live="polite">{deliberatingIn === activeId && deliberatingIn ? "thinking it through…" : typingIn === activeId && typingIn ? "typing…" : replyingHere ? "will reply in a moment" : loading ? "replying in another chat" : `online · ${mood.name}`}</span>
            <span className="status-trailing" title={activeConversation?.title}>{activeConversation?.title ?? UNTITLED}</span>
          </div>
          <div
            className={`composer-wrap ${dragActive ? "drag-active" : ""}`}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragActive(true); } }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
            onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDragActive(false); void addFiles(event.dataTransfer.files); }}
          >
            {(pendingFiles.length > 0 || preparingFiles > 0) && <div className="composer-attachments">
              <AttachmentList items={pendingFiles} onRemove={removePendingFile}/>
              {preparingFiles > 0 && <span className="attachment-preparing">PREPARING {preparingFiles}…</span>}
            </div>}
            {refineTarget && <span className="composer-reply">
              <span aria-hidden="true">◇</span>
              <span className="composer-reply-text">Refining {refineTarget.visualization?.title}</span>
              <button type="button" onClick={() => setRefiningId("")} aria-label="Stop refining">×</button>
            </span>}
            {replyTarget && <span className="composer-reply">
              <span aria-hidden="true">↩</span>
              <span className="composer-reply-text" title={messagePreview(replyTarget, 200)}>{messagePreview(replyTarget, 60)}</span>
              <button type="button" onClick={() => setReplyingToId("")} aria-label="Cancel reply">×</button>
            </span>}
            {commandHints(input).length > 0 && <div className="command-hints" role="listbox" aria-label="Commands">
              {commandHints(input).map((command) => <button type="button" role="option" aria-selected={false} key={command.name} onClick={() => { setInput(`/${command.name} `); composerRef.current?.focus(); }}>
                <b>/{command.name}</b><span>{command.hint}</span>
              </button>)}
            </div>}
            <form className="composer" onSubmit={sendMessage}>
              <button type="button" className="attach-button" onClick={() => fileInputRef.current?.click()} disabled={pendingFiles.length + preparingFiles >= MAX_ATTACHMENTS} aria-label="Attach images or files" title="Attach images or files (or paste / drop them)">
                <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M13.5 7.6 8.1 13a3.4 3.4 0 0 1-4.8-4.8l5.6-5.6a2.3 2.3 0 0 1 3.2 3.2L6.6 11.3a1.1 1.1 0 0 1-1.6-1.6l5-5"/></svg>
              </button>
              <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }}/>
              <textarea
                ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown}
                onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addFiles(files); } }}
                placeholder={refineTarget ? `What should change about ${refineTarget.visualization?.title}?` : replyingHere ? "Keep talking — she'll get to it…" : "Say something interesting…"} rows={1} maxLength={MAX_INPUT_CHARS} aria-label="Message FREYA"
              />
              {/* No stop button: FREYA finishes what she is saying, and anything sent meanwhile
                  is answered right after. */}
              {/* An empty composer offers the mic, as chat apps do; typing turns it into send. */}
              {transcribing
                ? <span className="transcribing" role="status">SENDING VOICE…</span>
                : !input.trim() && !pendingFiles.length
                  ? <VoiceRecorder onRecorded={(recording, seconds) => void sendVoice(recording, seconds)} onProblem={(problem) => notify(problem, "error")} disabled={preparingFiles > 0}/>
                  : <button className="send-button" type="submit" disabled={preparingFiles > 0} aria-label={loading ? "Send — FREYA answers after her current reply" : "Send message"}>↑</button>}
            </form>
          </div>
          <div className="conversation-shell">
            <div ref={conversationRef} onScroll={handleConversationScroll} className={`conversation ${messages.length === 0 ? "welcome" : ""}`}>
              {messages.length === 0 ? <div className="welcome-content">

                <div className="suggestions">{["Let's have a real conversation.", "Explain something people often misunderstand.", "Help me think through a difficult decision."].map((suggestion) => <button key={suggestion} onClick={() => { setInput(suggestion); composerRef.current?.focus(); }}>{suggestion}</button>)}</div>
              </div> : <div className="message-list">
                {messages.map((message, index) => {
                  const info = thread[index];
                  const clock = info.endsRun ? formatClock(message.at) : "";
                  return <article key={message.id} id={`message-${message.id}`} className={`message ${message.role} ${message.longform ? "longform" : ""} ${info.startsRun ? "run-start" : "run-continued"} ${info.endsRun ? "run-end" : ""}`}>
                    <div className="avatar" aria-hidden="true">{message.role === "assistant" ? "F" : "Y"}</div>
                    <div className="message-body">
                      {info.startsRun && <div className="message-heading">
                        <div className="message-name">{message.role === "assistant" ? "FREYA" : "YOU"}</div>
                      </div>}
                      <div className="message-line">
                      <div className={`message-main ${message.reaction || message.herReaction ? "has-reaction" : ""}`}>
                      {message.attachments && message.attachments.length > 0 && <AttachmentList items={message.attachments} onUnavailable={() => notify("That file is no longer stored in this browser.", "error")}/>}
                      {editingId === message.id
                        ? <div className="message-edit">
                          <textarea
                            autoFocus value={editText} rows={Math.min(8, editText.split("\n").length + 1)} maxLength={MAX_INPUT_CHARS} aria-label="Edit your message"
                            onChange={(event) => setEditText(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") { event.preventDefault(); setEditingId(""); }
                              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); saveEdit(message); }
                            }}
                          />
                          <div className="message-edit-actions">
                            <button type="button" onClick={() => setEditingId("")}>Cancel</button>
                            <button type="button" onClick={() => saveEdit(message)}>Save</button>
                          </div>
                        </div>
                        : message.command
                        ? <div className="command-chip"><span className="command-chip-label">{message.command === "image" ? "PICTURE" : message.command === "refine" ? "REFINE" : "VISUALIZE"}</span><span>{message.content}</span></div>
                        : message.visualization
                        ? <VisualizationCard info={message.visualization} onShow={() => void showVisualization(message)} onRefine={message.visualization.spec?.technique === "portrait" ? undefined : () => tagForRefine(message)} tagged={refiningId === message.id}/>
                        : message.picture
                        ? <PictureCard info={message.picture} onRefine={startRefine}/>
                        : message.longform
                        ? <LongformMessage content={message.content} streaming={Boolean(message.streaming)}/>
                        : message.voice || message.spoken
                        ? <VoiceNote messageId={message.id} transcript={message.content} audio={message.voice} onProblem={(problem) => notify(problem, "error")}/>
                        : message.content && (message.role === "assistant"
                          ? <div className="assistant-body"><MarkdownContent content={message.content}/></div>
                          : <div className="message-text">{message.content}</div>)}
                      {message.reaction && <button type="button" className="message-reaction" onClick={() => toggleReaction(message, message.reaction!)} aria-label={`Remove your ${message.reaction} reaction`} title="Remove reaction">{message.reaction}</button>}
                      {message.herReaction && <span className="message-reaction her-reaction" role="img" aria-label={`FREYA reacted ${message.herReaction}`} title="FREYA's reaction">{message.herReaction}</span>}
                      </div>
                      {info.tag && <button type="button" className="reply-side" onClick={() => jumpToMessage(info.tag!.id)} title={`Replying to: ${messagePreview(info.tag as Message, 200)}`} aria-label={`Replying to: ${messagePreview(info.tag as Message, 200)}`}>
                        <span aria-hidden="true">↩</span><span className="reply-side-text">{(info.tag as Message).visualization?.title ?? messagePreview(info.tag as Message, 40)}</span>
                      </button>}
                      {!message.streaming && !message.command && editingId !== message.id && <div className="message-tools">
                        <button type="button" onClick={() => startReply(message.id)} aria-label={`Reply to: ${messagePreview(message, 60)}`} title="Reply">↩</button>
                        <button type="button" onClick={() => setReactingToId((current) => current === message.id ? "" : message.id)} aria-expanded={reactingToId === message.id} aria-label={`React to: ${messagePreview(message, 60)}`} title="React">☺</button>
                        <button type="button" onClick={() => void copyMessage(message)} aria-label={`Copy: ${messagePreview(message, 60)}`} title={copiedId === message.id ? "Copied" : "Copy"}>{copiedId === message.id ? "✓" : "⧉"}</button>
                        {message.role === "user" && !message.voice && !message.visualization && !message.picture && <button type="button" onClick={() => { if (replyingHere) { notify("Wait for her to finish replying, then edit it.", "info"); return; } setEditText(message.content); setEditingId(message.id); setReactingToId(""); }} aria-label={`Edit: ${messagePreview(message, 60)}`} title="Edit">✎</button>}
                        {message.role === "assistant" && message.content.trim() && <button type="button" onClick={() => void markNotHer(message)} aria-label={`Not her: ${messagePreview(message, 60)}`} title="Not her">⚑</button>}
                        {reactingToId === message.id && <div className="reaction-picker" role="group" aria-label="Reactions">
                          {REACTIONS.map((reaction) => <button type="button" key={reaction} className={message.reaction === reaction ? "selected" : ""} onClick={() => toggleReaction(message, reaction)} aria-label={`React with ${reaction}`}>{reaction}</button>)}
                        </div>}
                      </div>}
                      </div>
                      {message.sources && message.sources.length > 0 && <div className="source-list"><div className="source-heading">RETRIEVED SOURCES</div>{message.sources.filter((source) => { try { return ["http:", "https:"].includes(new URL(source.url).protocol); } catch { return false; } }).map((source) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>)}</div>}
                      {(message.queued || clock || (info.endsTurn && message.provider)) && <div className="message-meta">
                        {message.queued && <span className="queued">QUEUED</span>}
                        {message.edited && <span>EDITED</span>}
                        {message.reasoned && <span title={`Worked through first by ${message.reasoned.length} independent analyst${message.reasoned.length === 1 ? "" : "s"} (${message.reasoned.join(" + ")})`}>REASONED</span>}
                        {info.endsTurn && message.provider && <span title={`Response generated by ${message.provider}`}>{message.provider === "ollama" ? "LOCAL" : message.provider.toUpperCase()}</span>}
                        {clock && <time dateTime={message.at}>{clock}</time>}
                      </div>}
                      {message.id === truncatedReplyId && !loading && <button type="button" className="continue-reply" onClick={() => void continueReply()}>↳ Continue this reply</button>}
                      {/* Resend only where it means something: a failed message, or the last one left unanswered. */}
                      {message.role === "user" && !replyingHere && (message.failed || (awaitingReply && index === messages.length - 1)) && <div className="resend-row">
                        {message.failed && <span>NOT DELIVERED</span>}
                        <button type="button" className="resend-button" onClick={() => resendMessage(message.id)}>↻ Resend</button>
                      </div>}
                    </div>
                  </article>;
                })}
                {typingIn === activeId && typingIn && <article className="message assistant typing-row" aria-live="polite">
                  <div className="avatar" aria-hidden="true">F</div>
                  <div className="message-body">
                    <div className="typing" aria-label={deliberatingIn === activeId ? "FREYA is thinking it through" : "FREYA is typing"}><i/><i/><i/>{deliberatingIn === activeId && <span className="typing-label">thinking it through…</span>}</div>
                  </div>
                </article>}
                <div ref={bottomRef}/>
              </div>}
            </div>
            {!atBottom && messages.length > 0 && <button type="button" className="jump-latest" onClick={() => { atBottomRef.current = true; setAtBottom(true); scrollToBottom(); }}>↓ Latest</button>}
          </div>
          <EmotionCanvas signal={canvasSignal} mood={mood} form={canvasForm} onClearForm={() => setCanvasForm(null)}/>
          <div className="center-privacy-note">FREYA is a fictional character played by an AI · replies can be wrong · type /visualize or /image for pictures</div>
        </section>

        <aside className="profile-panel" aria-label="FREYA profile">
          <PortraitParticles expression={portraitExpression} />
          <div className="profile-name-row"><h2>FREYA, 20</h2><span className="profile-state">ONLINE · {mood.name.toUpperCase()}</span></div>
          <p className="profile-description">Hey, I&apos;m Freya. I read too much, stay up too late, and have opinions about most things.</p>
          <div className="profile-sigil" aria-hidden="true">✦</div>
          <p className="profile-footnote">Your portrait, lit as a 3D relief. Her expression follows her simulated mood and the conversation; no face scanning or recognition.</p>
        </aside>
      </div>
    </main>
  );
}
