import {createContext} from 'react';
/** One composer owns the durable draft even when the notes history is visible. */
export const QuickNoteContext=createContext<(()=>void)|null>(null);
