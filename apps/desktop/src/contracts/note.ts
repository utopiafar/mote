/** Renderer/main data contract. Keep platform and implementation dependencies outside this module. */

export interface NoteDraft { id: string; text: string; mood: string; description: string; revision: number; prepared?: boolean }
