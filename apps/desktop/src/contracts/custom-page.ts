/** Pure desktop contract DTOs for the custom-page guard. This leaf must not
 * import implementation modules: the renderer/preload contract and the
 * main-process guard both depend on it, never the reverse. */
export interface CustomPageFrameTarget {
  readonly instanceId: string;
  readonly nonce: string;
  readonly documentKey: string;
  readonly entryUrl: string;
}

export interface CustomPageFrameClaim {
  readonly instanceId: string;
  readonly nonce: string;
  readonly documentKey: string;
}

export interface CustomPageFrameGrant {
  readonly frameTreeNodeId: number;
  readonly epoch: number;
}

/** Pushed to the trusted host when a bound custom page frame is revoked, so
 * the consumer can end its channel instead of relying on a private counter. */
export interface CustomPageFrameRevocation {
  readonly instanceId: string;
  readonly nonce: string;
  readonly documentKey: string;
  readonly frameTreeNodeId: number;
  readonly epoch: number;
}
