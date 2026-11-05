export type Answer = { kind: 'text'; text: string } | { kind: 'form'; values: Record<string, string | string[]> }
  | { kind: 'permission'; decision: 'approve' | 'deny'; optionCode?: string };
export interface Option { code: string; label: string; decision?: 'approve' | 'deny' }
export interface AnswerField {
  fieldId: string; label: string; required: boolean; valueType: 'text' | 'choice' | 'choices'; options?: Option[];
}
export type AnswerSchema = { mode: 'text' } | { mode: 'form'; fields: AnswerField[] };
const optionSchema=z.strictObject({code:z.string().min(1),label:z.string(),decision:z.enum(['approve','deny']).optional()});
const optionsSchema=z.array(optionSchema).refine(options=>new Set(options.map(option=>option.code)).size===options.length);
export const answerSchemaSchema=z.discriminatedUnion('mode',[
  z.strictObject({mode:z.literal('text')}),
  z.strictObject({mode:z.literal('form'),fields:z.array(z.strictObject({fieldId:z.string().min(1),label:z.string(),required:z.boolean(),
    valueType:z.enum(['text','choice','choices']),options:optionsSchema.optional()})).refine(fields=>new Set(fields.map(field=>field.fieldId)).size===fields.length)}),
]);
export const permissionOptionsSchema=optionsSchema.refine(options=>options.length>0&&options.every(option=>option.decision!==undefined));

export function validateAnswer(schema:AnswerSchema,raw:string):Extract<Answer,{kind:'text'|'form'}>|undefined {
  if(schema.mode==='text')return raw.trim()?{kind:'text',text:raw}:undefined;
  let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return undefined;}
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))return undefined;
  const values=parsed as Record<string,unknown>,fields=new Map(schema.fields.map(field=>[field.fieldId,field]));
  if(Object.keys(values).some(key=>!fields.has(key)))return undefined;
  for(const field of schema.fields) {
    const value=values[field.fieldId];
    if(value===undefined){if(field.required)return undefined;continue;}
    const codes=new Set(field.options?.map(option=>option.code)??[]);
    if(field.valueType==='text' && (typeof value!=='string' || (field.required&&!value.trim())))return undefined;
    if(field.valueType==='choice' && (typeof value!=='string' || !codes.has(value)))return undefined;
    if(field.valueType==='choices' && (!Array.isArray(value) || (field.required&&value.length===0) || value.some(v=>typeof v!=='string'||!codes.has(v)) || new Set(value).size!==value.length))return undefined;
  }
  return {kind:'form',values:values as Record<string,string|string[]>};
}
import { z } from 'zod';
