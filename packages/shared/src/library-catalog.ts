/** Safe presentation anchors. They describe installed code; they never contain code or URLs. */
export type LibraryTypeDescriptor={id:string;kind:string;schemaVersion:number;label:string;card?:string;detail?:string;panels?:string[];actions?:string[]};
export type LibrarySourceFacet={id:string;label:string;count:number};
export type LibraryCatalogDescriptor={schemaVersion:1;revision:number;types:LibraryTypeDescriptor[]};
