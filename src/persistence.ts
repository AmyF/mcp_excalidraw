import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { elements, files, snapshots } from './types.js';
import type { ServerElement, ExcalidrawFile, Snapshot } from './types.js';

export const AppStateSchema = z.object({
  viewBackgroundColor: z.string().optional(),
  gridSize: z.number().positive().nullable().optional(),
  gridStep: z.number().positive().optional(),
  gridModeEnabled: z.boolean().optional()
});
export type CanvasAppState = z.infer<typeof AppStateSchema>;
export const canvasAppState: CanvasAppState = {};

export const FileSchema = z.object({
  id: z.string().min(1), dataURL: z.string().startsWith('data:'),
  mimeType: z.string().min(1), created: z.number().finite()
}).passthrough();
const StoredElementSchema = z.object({
  id: z.string().min(1), type: z.string().min(1),
  x: z.number().finite(), y: z.number().finite()
}).passthrough();
const SceneSchema = z.object({
  elements: z.array(StoredElementSchema),
  files: z.record(FileSchema),
  appState: AppStateSchema
});
const StateSchema = SceneSchema.extend({
  formatVersion: z.literal(1),
  snapshots: z.record(SceneSchema.extend({ name: z.string().min(1), createdAt: z.string() }))
});
type StoredState = z.infer<typeof StateSchema>;
let dataDirectory: string | undefined;
let committedJson: string | undefined;
let initialized = false;
let storageFailure: string | undefined;

export function sceneState() {
  return {
    elements: Array.from(elements.values()),
    files: Object.fromEntries(files),
    appState: { ...canvasAppState }
  };
}

function captureState(): StoredState {
  return structuredClone({
    formatVersion: 1 as const,
    ...sceneState(),
    snapshots: Object.fromEntries(snapshots)
  }) as StoredState;
}

export function setAppState(value: CanvasAppState): void {
  for (const key of Object.keys(canvasAppState)) delete (canvasAppState as Record<string, unknown>)[key];
  Object.assign(canvasAppState, value);
}

function restoreState(state: StoredState): void {
  elements.clear();
  for (const element of state.elements) elements.set(element.id, element as ServerElement);
  files.clear();
  for (const file of Object.values(state.files)) files.set(file.id, file as ExcalidrawFile);
  snapshots.clear();
  for (const [name, snapshot] of Object.entries(state.snapshots)) snapshots.set(name, snapshot as Snapshot);
  setAppState(state.appState);
}

function validateReferences(scene: z.infer<typeof SceneSchema>): void {
  const ids = new Set<string>();
  for (const element of scene.elements) {
    if (ids.has(element.id)) throw new Error(`Duplicate element id: ${element.id}`);
    ids.add(element.id);
    if (element.type === 'image' && !element.isDeleted && typeof element.fileId === 'string' &&
        !Object.hasOwn(scene.files, element.fileId)) {
      throw new Error(`Image ${element.id} references missing file ${element.fileId}`);
    }
  }
  for (const [id, file] of Object.entries(scene.files)) {
    if (file.id !== id) throw new Error(`Image file key does not match its id: ${id}`);
  }
}

function validateState(value: unknown): StoredState {
  const state = StateSchema.parse(value);
  validateReferences(state);
  for (const [name, snapshot] of Object.entries(state.snapshots)) {
    if (name !== snapshot.name) throw new Error(`Snapshot key does not match its name: ${name}`);
    validateReferences(snapshot);
  }
  return state;
}

function writeAtomically(filename: string, content: string): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    const directory = fs.openSync(path.dirname(filename), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function backupCurrent(reason?: string): void {
  if (!dataDirectory || !committedJson) return;
  const backupDirectory = path.join(dataDirectory, 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  writeAtomically(path.join(dataDirectory, 'previous.json'), committedJson);
  const today = new Date().toISOString().slice(0, 10);
  const daily = path.join(backupDirectory, `daily-${today}.json`);
  if (!fs.existsSync(daily)) writeAtomically(daily, committedJson);
  if (reason) {
    const stamp = new Date().toISOString().replaceAll(':', '-');
    writeAtomically(path.join(backupDirectory, `before-${reason}-${stamp}-${randomUUID()}.json`), committedJson);
  }
  const cutoff = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  for (const name of fs.readdirSync(backupDirectory)) {
    if (/^daily-\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(6, 16) < cutoff) {
      fs.unlinkSync(path.join(backupDirectory, name));
    }
  }
}

export function initializePersistence(): void {
  dataDirectory = process.env.EXCALIDRAW_DATA_DIR;
  if (!dataDirectory) { initialized = true; return; }
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDirectory, 'state.json');
  if (fs.existsSync(filename)) {
    const raw = fs.readFileSync(filename, 'utf8');
    const state = validateState(JSON.parse(raw));
    restoreState(state);
    committedJson = raw;
  } else {
    const state = validateState(captureState());
    committedJson = JSON.stringify(state);
    writeAtomically(filename, committedJson);
  }
  fs.accessSync(dataDirectory, fs.constants.W_OK);
  initialized = true;
}

export function persistenceStatus() {
  return { ready: initialized && !storageFailure, enabled: Boolean(dataDirectory), error: storageFailure };
}

// Synchronous transactions cannot interleave on Node's event loop. Callers must
// broadcast and acknowledge only after this returns. Failed writes roll back
// memory and lock further edits until an operator resolves the storage failure.
export function commitMutation<T>(mutate: () => T, backupReason?: string): T {
  if (storageFailure) throw new Error(`Storage unavailable: ${storageFailure}`);
  const previous = captureState();
  try {
    const result = mutate();
    const state = validateState(captureState());
    if (dataDirectory) {
      const nextJson = JSON.stringify(state);
      if (nextJson !== committedJson) {
        try {
          backupCurrent(backupReason);
          writeAtomically(path.join(dataDirectory, 'state.json'), nextJson);
          committedJson = nextJson;
        } catch (error) {
          storageFailure = (error as Error).message;
          throw new Error(`Canvas could not be saved: ${storageFailure}`);
        }
      }
    }
    return result;
  } catch (error) {
    restoreState(previous);
    throw error;
  }
}
