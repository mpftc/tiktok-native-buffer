"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { QualityPolicy, choose, label } = require("../src/quality-policy.cjs");
const { PageAdapter } = require("../src/page-adapter.cjs");
const { RangeEngine } = require("../src/range-engine.cjs");
const U = require("../src/utils.cjs");
const low = { width:720,height:1280,codecType:"h264",format:"MP4",bitrate:4000000,definition:"normal_720_0",url:["https://v16-webapp-prime.tiktok.com/video/low"] };
const high = { width:1080,height:1920,codecType:"h265",format:"DASH",bitrate:1500000,definition:"adapt_lowest_1080_1",url:["https://v16-webapp-prime.tiktok.com/video/high"],mediaExtra:{audioFileId:"a"} };
function fixture() {
  const config = { videoInfo: {vid:"video1",bitrateList:[low,high],audioBitrateList:[{fileId:"a"},{fileId:"b"}]},playerConfig:{codecType:"h264",format:"MP4"} };
  const settings = { enabled:true,highestQuality:true };
  const root = {document:{createElement:()=>({canPlayType:()=>"probably"})}};
  const policy = new QualityPolicy(root,()=>settings); policy.armed=true;
  return {policy,config,settings};
}
test("highest resolution beats bitrate; unsupported codecs remain excluded",()=>{
  assert.equal(choose([low,high],{h264:true,h265:true}),high);
  assert.equal(choose([low,high],{h264:true,h265:false}),low);
  assert.equal(choose([high],{h264:true}),null);
  assert.equal(label(high),"1080P");
});
test("native and feed models choose the same highest variant",()=>{
  const raw = [low,high].map(v=>({width:v.width,height:v.height,codec:v.codecType,format:v.format.toLowerCase(),bitrate:v.bitrate,gear:v.definition}));
  assert.equal(label(choose(raw,{h264:true,h265:true})),label(choose([low,high],{h264:true,h265:true})));
});
test("single native version is cloned with its matching audio and codec",()=>{
  const {policy,config}=fixture(), result=policy.prepare(config);
  assert.notEqual(result,config); assert.deepEqual(result.videoInfo.bitrateList,[high]);
  assert.deepEqual(result.videoInfo.audioBitrateList,[{fileId:"a"}]);
  assert.equal(result.playerConfig.codecType,"h265"); assert.equal(result.playerConfig.format,"DASH");
  assert.equal(config.videoInfo.bitrateList.length,2); assert.equal(config.videoInfo.audioBitrateList.length,2);
});
test("missing required DASH audio preserves original native config",()=>{
  const {policy,config}=fixture(); config.videoInfo.audioBitrateList=[];
  assert.equal(policy.prepare(config),config);
});
test("disarmed or disabled policy leaves original configuration intact",()=>{
  const {policy,config,settings}=fixture();policy.armed=false;assert.equal(policy.prepare(config),config);
  policy.armed=true;settings.highestQuality=false;assert.equal(policy.prepare(config),config);
});
function nativeFixture() {
  const f=fixture();
  const element={currentTime:12.5,paused:true,volume:0.6,muted:true,playbackRate:1.5};
  class Native {
    constructor(){this.playerType="NEW_TT";this.element=element;this.state="backup";this.calls=0;this._init(f.config);}
    _init(config){this.config=config;this.vid=config.videoInfo.vid;this.bitrateList=config.videoInfo.bitrateList;this.curBitrate=this.bitrateList[0];}
    changeVideo(config,state){this.calls++;this.state=state;this._init(config);}
  }
  const player=new Native(),wrapper={__reactFiber$fixture:{memoizedProps:{player}}};element.closest=()=>wrapper;
  return {...f,player,element,Native};
}
test("existing native player switches through its own path with playback state preserved",()=>{
  const {policy,player,element}=nativeFixture();policy.scan([element]);
  assert.equal(player.curBitrate,high);assert.equal(player.calls,1);assert.equal(player.element,element);
  assert.equal(player.config.playerConfig.startTime,12.5);assert.equal(player.config.playerConfig.autoplay,false);
  assert.equal(player.config.playerConfig.playbackRate,1.5);assert.equal(player.config.playerConfig.volume,0.6);
  assert.equal(policy.status("video1").status,"locked");policy.scan([element]);assert.equal(player.calls,1);policy.dispose();
});
test("future native initialization is constrained; disabling restores original choices",()=>{
  const {policy,player,element,config,settings}=nativeFixture();policy.scan([element]);
  player.changeVideo({...config,videoInfo:{...config.videoInfo,vid:"video2"}},"active");
  assert.equal(player.curBitrate,high);assert.equal(player.bitrateList.length,1);
  const previous={...settings};settings.highestQuality=false;policy.update(previous,settings);
  assert.equal(player.bitrateList.length,2);assert.equal(player.curBitrate,low);policy.dispose();
});
test("quality preparation can register an upcoming video before any native selection",()=>{
  const engine=new RangeEngine(()=>{throw new Error("Unexpected network");},U.normalize());
  const variant={...high,codec:"h265",gear:high.definition,video:{urls:high.url,role:"video"},audio:{urls:["https://v16-webapp-prime.tiktok.com/video/audio"],fileId:"a"}};
  const item={id:"future",variants:[variant],selected:null,duration:20};
  const adapter=Object.create(PageAdapter.prototype);adapter.engine=engine;adapter.quality={available:true,support:{h265:true},status:()=>({status:"planned"})};
  const resources=adapter.selectedResources(item);assert.equal(resources.length,2);assert.equal(item.selected,null);assert.equal(item.preferred,variant);
  for(const r of resources){r.total=10;r.indexTried=true;engine.store.insert(r,0,new Uint8Array(10),engine.store.reserve(10));}
  assert.deepEqual(adapter.cachedTimes(item),[[0,20]]);
});
