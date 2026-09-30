import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postProcessAssistantContent } from './imageGenAssist';
import { useModelStore } from '../store/modelStore';
import type { ModelConfig } from '../types';
const model: ModelConfig = {id:'image', name:'images', provider:'openai', apiUrl:'https://example.com', modelName:'chat', isLocal:false, maxTokens:4096, isImageGenerator:true, imageGeneratorConfig:{type:'http', endpoint:'https://example.com/images/generations'}};
const tool = (count = 1) => JSON.stringify({myagent_tool:'generate_image',prompt:'A blue watercolor cat',width:1536,height:1024,count});
const img = {path:'/tmp/image.png',url:'file:///tmp/image.png',width:1536,height:1024};
describe('image execution boundary', () => {
  beforeEach(() => { useModelStore.setState({models:[model],imageGenModelId:model.id}); window.electron.generateImage = vi.fn().mockResolvedValue([img]); });
  it('retains model prompt, dimensions and user count without extra style', async () => {
    await postProcessAssistantContent(tool(3), model, 0, vi.fn(), {userPromptContext:'生成一张图，里面有3个人',plannedIntent:{shouldGenerate:true,prompt:'生成一张图，里面有3个人'}});
    expect(window.electron.generateImage).toHaveBeenCalledWith(expect.objectContaining({prompt:'A blue watercolor cat',count:1,width:1536,height:1024}),expect.anything());
  });
  it('never executes a tool embedded in a discussion', async () => {
    await postProcessAssistantContent(tool(),model,0,vi.fn(),{userPromptContext:'不要生图，只解释'});
    expect(window.electron.generateImage).not.toHaveBeenCalled();
  });
  it('preserves partial images and reports partial failure', async () => {
    window.electron.generateImage = vi.fn(async (_params, handlers) => { handlers?.onImage?.({requestId:'x',image:img,index:1,total:3}); throw new Error('network failure'); });
    const result = await postProcessAssistantContent(tool(3),model,0,vi.fn(),{userPromptContext:'生成三张图片'});
    expect(result.files).toHaveLength(1);
    expect(result.content).toContain('1/3');
    expect(result.content).toContain('network failure');
  });
  it('does not execute after cancellation', async () => {
    await postProcessAssistantContent(tool(),model,0,vi.fn(),{shouldCancel:()=>true});
    expect(window.electron.generateImage).not.toHaveBeenCalled();
  });
  it('does not invent a count when the model asks to clarify a group', async () => {
    await postProcessAssistantContent('请提供角色名单',model,0,vi.fn(),{plannedIntent:{shouldGenerate:true,prompt:'每个角色一张',needsCount:true}});
    expect(window.electron.generateImage).not.toHaveBeenCalled();
  });
  it('limits the aggregate output count across multiple tool calls', async () => {
    await postProcessAssistantContent(tool(8)+tool(8).replace('blue', 'red'),model,0,vi.fn(),{});
    expect(window.electron.generateImage).not.toHaveBeenCalled();
  });
});

it('does not turn a plain explanation into paid work even if keyword planning guessed generation', async () => {
 window.electron.generateImage = vi.fn();
 await postProcessAssistantContent('可以先确定画面主题。',model,0,vi.fn(),{userPromptContext:'生成一张图',plannedIntent:{shouldGenerate:true,prompt:'生成一张图'}});
 expect(window.electron.generateImage).not.toHaveBeenCalled();
});
