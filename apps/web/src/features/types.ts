import type {FeatureRequirement} from '@mote/shared';
import type { ReactNode } from 'react';
import type { Activity,Answer,Api,Capture,Device,Range,Status } from '../api';
import type { ArchiveTab } from '../Archive';
import type { Page } from '../navigation';
import type { SessionLifetime } from '../session';
export type PageProps={api:Api;status:Status|null;devices:Device[];activity:Activity;recent:Capture[];insights:Answer[];onPage:(page:Page)=>void;onOpen:(ref:string)=>void;range:Range;rangeSelectionKey?:string;archiveTab:ArchiveTab;setArchiveTab:(tab:ArchiveTab)=>void;timelineRevision:number;refresh:()=>void;disconnect:()=>void;sessionLifetime:SessionLifetime;changeSessionLifetime:(value:SessionLifetime)=>void};
export type PageEntry={id:string;route?:string;aliases?:string[];label?:string;section?:'library'|'connections'|'system';order?:number;featureId:string;version?:string;requires?:FeatureRequirement[];render:(props:PageProps)=>ReactNode};
export type HomeEntry={id:string;featureId:string;version?:string;requires?:FeatureRequirement[];order:number;render:(props:{api:Api;onPage:(page:Page)=>void})=>ReactNode};
export type ViewValue={kind:string;schemaVersion:number;representation:string;ref:string;revision:string;title:string;text:string;operationIds?:string[]};
export type ViewProps={value:ViewValue;api:Api;onOpen:(ref:string)=>void;fallback?:ReactNode;catalog?:import('@mote/shared').LibraryTypeDescriptor};
export type ViewEntry={id:string;version?:string;requires?:FeatureRequirement[];kind:string;schemaVersion:number;representation:string;render:(props:ViewProps)=>ReactNode};
export type CollectionProps={api:Api;devices:Device[];range:Range;rangeSelectionKey?:string;activity:Activity;revision:number;onOpen:(ref:string)=>void;onChanged?:()=>void;selectedReference?:string;onBrowseChanged?:()=>void};
export type CollectionEntry={id:string;featureId:string;label:string;order:number;version?:string;requires?:FeatureRequirement[];group?:'browse'|'records'|'views'|'processing';layout?:'browser'|'standalone';usesTimeRange?:boolean;render:(props:CollectionProps)=>ReactNode};

export type ActionEntry=ViewEntry & {position:'card'|'detail'};
