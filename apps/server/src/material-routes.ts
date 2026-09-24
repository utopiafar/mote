import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {MaterialStore,formatMaterialRef} from './materials.js';
import type {MaterialOrganizerRuntime} from './material-organizers.js';
import {StoreError} from './store.js';

const id=z.string().regex(/^mat_[a-f0-9]{64}$/);
const revision=z.string().regex(/^[a-f0-9]{64}$/);
const listQuery=z.object({query:z.string().min(1).max(500).optional(),sourceId:z.string().min(1).max(128).optional(),kind:z.string().min(1).max(128).optional(),
  deviceId:z.string().min(1).max(128).optional(),after:z.string().datetime({offset:true}).optional(),
  before:z.string().datetime({offset:true}).optional(),limit:z.coerce.number().int().min(1).max(100).optional(),
  cursor:z.string().max(4096).optional()}).strict();
const readQuery=z.object({revision:revision.optional(),offset:z.coerce.number().int().min(0).optional(),
  length:z.coerce.number().int().min(1).max(12000).optional()}).strict();
const memberQuery=z.object({revision:revision.optional(),offset:z.coerce.number().int().min(0).optional(),
  limit:z.coerce.number().int().min(1).max(200).optional()}).strict();

/** Mounted after the application's owner bearer authorization hook. */
export function registerMaterialRoutes(app:FastifyInstance,materials:MaterialStore,organizers?:MaterialOrganizerRuntime){
  if(organizers)app.get('/api/materials/status',async()=>organizers.status());
  app.get('/api/materials',async req=>materials.list(listQuery.parse(req.query)));
  app.get('/api/materials/:id',async req=>{
    const material=materials.get(id.parse((req.params as {id:string}).id));
    if(!material)throw new StoreError('Material not found',404);return material;
  });
  app.get('/api/materials/:id/read',async req=>{
    const materialId=id.parse((req.params as {id:string}).id),{revision:version,...range}=readQuery.parse(req.query);
    return materials.read(version?formatMaterialRef(materialId,version):materialId,range);
  });
  app.get('/api/materials/:id/members',async req=>{
    const materialId=id.parse((req.params as {id:string}).id),{revision:version,...range}=memberQuery.parse(req.query);
    return materials.members(version?formatMaterialRef(materialId,version):materialId,range);
  });
  app.get('/api/materials/:id/revisions/:revision',async req=>{
    const params=req.params as {id:string;revision:string};
    const material=materials.get(formatMaterialRef(id.parse(params.id),revision.parse(params.revision)));
    if(!material)throw new StoreError('Material not found',404);return material;
  });
}
