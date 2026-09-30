import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const exec=promisify(execFile),app=express(); app.use(express.json({limit:"20mb"}));
const SECRET=process.env.BUILD_RUNNER_SECRET||"change-me";
const PORT=process.env.PORT||8090;
const jobs=new Map();
function auth(req,res,next){if(req.headers.authorization!==`Bearer ${SECRET}`)return res.status(401).json({error:"Unauthorized"});next()}
app.get("/health",(req,res)=>res.json({ok:true,runner:"flutter"}));
app.post("/builds",auth,async(req,res)=>{
 try{
  const id=crypto.randomUUID(), dir=await fs.mkdtemp(path.join(os.tmpdir(),"flutter-build-"));
  const files=Array.isArray(req.body?.files)?req.body.files:[];
  await Promise.all(files.map(async f=>{if(!f?.path||f.path.includes("..")||path.isAbsolute(f.path))throw new Error("Invalid project path");const p=path.join(dir,f.path);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,String(f.content||""));}));
  const format=req.body?.format==="aab"?"aab":"apk"; jobs.set(id,{id,status:"queued",format,dir});
  run(id).catch(e=>{const j=jobs.get(id);if(j){j.status="failed";j.error=e.message}});
  res.status(202).json({id,status:"queued"});
 }catch(e){res.status(400).json({error:e.message||"Invalid build request"});}
});
async function run(id){const j=jobs.get(id);j.status="running";
 try{await exec("flutter",["pub","get"],{cwd:j.dir,timeout:120000});
 await exec("flutter",["analyze"],{cwd:j.dir,timeout:120000});
 const target=j.format==="aab"?"appbundle":"apk";
 await exec("flutter",["build",target,"--release"],{cwd:j.dir,timeout:600000});
 const artifact=j.format==="aab"?"build/app/outputs/bundle/release/app-release.aab":"build/app/outputs/flutter-apk/app-release.apk";
 await fs.access(path.join(j.dir,artifact));
 j.status="successful";j.artifact=path.join(j.dir,artifact);
 }catch(e){j.status="failed";j.error=(e.stderr||e.stdout||e.message).slice(-12000)}}
app.get("/builds/:id",auth,(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Build not found"});res.json({id:j.id,status:j.status,format:j.format,error:j.error||null,artifactReady:j.status==="successful"});});
app.get("/builds/:id/artifact",auth,async(req,res)=>{
 const j=jobs.get(req.params.id);
 if(!j)return res.status(404).json({error:"Build not found"});
 if(j.status!=="successful"||!j.artifact)return res.status(409).json({error:"Artifact is not ready"});
 try{
  await fs.access(j.artifact);
  const filename=j.format==="aab"?"app-release.aab":"app-release.apk";
  res.download(j.artifact,filename,err=>{if(err&&!res.headersSent)res.status(500).json({error:"Artifact download failed"});});
 }catch(e){res.status(404).json({error:"Artifact file is unavailable"});}
});
app.listen(PORT,()=>console.log(`Flutter runner listening on ${PORT}`));