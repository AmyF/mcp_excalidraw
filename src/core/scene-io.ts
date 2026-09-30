import fs from 'fs';
import { generateId, ServerElement } from '../types.js';
import { getScene, applyScene } from './canvas-client.js';
import { sanitizeFilePath } from './normalize.js';
import { isObsidianExcalidrawMd, extractSceneJsonFromObsidianMd } from './obsidian-md.js';
import { expandElementsForExport } from './expand-elements.js';

export interface ExportedScene {
  scene: Record<string, any>;
  elementCount: number;
}

// Build a .excalidraw scene JSON from the current canvas state.
// Elements are expanded from the agent format (label/start/end) into real
// Excalidraw elements (bound text pairs, arrow bindings) so the file renders
// fully on excalidraw.com and in the Obsidian Excalidraw plugin — with
// deterministic ids/seeds so re-exporting an unchanged scene is byte-stable.
export async function buildSceneFile(): Promise<ExportedScene> {
  const current = await getScene();
  const exportElements = expandElementsForExport(current.elements, { deterministic: true });
  const sceneFiles = current.files;

  const excalidrawScene: Record<string, any> = {
    type: 'excalidraw',
    version: 2,
    source: 'mcp-excalidraw-server',
    elements: exportElements,
    appState: current.appState,
    ...(Object.keys(sceneFiles).length > 0 ? { files: sceneFiles } : {})
  };

  return { scene: excalidrawScene, elementCount: exportElements.length };
}

export interface ImportResult {
  count: number;
  fileCount: number;
  mode: 'replace' | 'merge';
}

// Import elements from a .excalidraw JSON file, an Obsidian .excalidraw.md
// file, or raw JSON data
export async function importScene(options: {
  filePath?: string;
  data?: string;
  mode: 'replace' | 'merge';
}): Promise<ImportResult> {
  let raw: string;
  if (options.filePath) {
    const safeImportPath = sanitizeFilePath(options.filePath);
    raw = fs.readFileSync(safeImportPath, 'utf-8');
  } else if (options.data) {
    raw = options.data;
  } else {
    throw new Error('Either filePath or data must be provided');
  }
  if (isObsidianExcalidrawMd(raw)) {
    raw = extractSceneJsonFromObsidianMd(raw);
  }
  const sceneData: any = JSON.parse(raw);

  const importElements: ServerElement[] = Array.isArray(sceneData) ? sceneData : sceneData.elements;
  if (!Array.isArray(importElements)) throw new Error('Scene must contain an elements array');
  const elementsToCreate = importElements.map(element => ({ ...element, id: element.id || generateId() }));
  const result = await applyScene({
    elements: elementsToCreate,
    files: Array.isArray(sceneData) ? {} : (sceneData.files || {}),
    appState: Array.isArray(sceneData) ? {} : (sceneData.appState || {}),
    mode: options.mode
  });
  return { count: result.count, fileCount: result.fileCount, mode: options.mode };

}
