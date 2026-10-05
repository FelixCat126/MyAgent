// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { openAiImagesAdapter } from './openAiImages';
import type { ModelConfig, ImageGenerationParams } from '../../../../src/types';
const build = (model:string, params:ImageGenerationParams={prompt:'cat'}) => openAiImagesAdapter.build({ endpoint:'https://api.openai.com/v1/images/generations',config:{type:'http',model,provider:'openai-images'} as NonNullable<ModelConfig['imageGeneratorConfig']>,env:{},headers:{},request:{prompt:params.prompt,count:params.count??1,width:params.width,height:params.height,referenceImages:params.referenceImages??[],params}});
describe('OpenAI image request capabilities',()=>{
 it('omits legacy response_format and supports transparent background',async()=>{
  const r=await build('gpt-image-1',{prompt:'cat',background:'transparent'});
  expect(r.body).not.toHaveProperty('response_format');
  expect(r.body).toMatchObject({background:'transparent',output_format:'png'});
 });
 it('routes reference images to edits instead of silently discarding them',async()=>{
  const ref='data:image/png;base64,' + createCanvas(10, 10).toBuffer('image/png').toString('base64');
  const r=await build('gpt-image-1',{prompt:'white background',referenceImages:[ref]});
  expect(r.endpoint).toBe('https://api.openai.com/v1/images/edits');
  expect(r.formData?.get('image')).toBeInstanceOf(Blob);
  expect(r.formData?.get('prompt')).toBe('white background');
 });
 it('keeps DALL-E generation parameters compatible',async()=>{
  const r=await build('dall-e-3',{prompt:'cat',count:4});
  expect(r.body).toMatchObject({n:1,response_format:'b64_json'});
 });
 it('fails clearly when a reference cannot be loaded',async()=>{
  await expect(build('gpt-image-1',{prompt:'cat',referenceImages:['/nonexistent/myagent-test.png']})).rejects.toThrow();
 });
});
