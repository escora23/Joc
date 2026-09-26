import { PNG } from 'pngjs'; import fs from 'node:fs';
const d=process.argv[2], alt=process.argv[3];
const a=PNG.sync.read(fs.readFileSync(`${d}/flash-${alt}-mid.png`)), b=PNG.sync.read(fs.readFileSync(`${d}/flash-${alt}-after.png`));
const L=(v)=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
const W=a.width,H=a.height,Y=new Float32Array(W*H);
for(let i=0;i<W*H;i++){let s=0;const w=[.2126,.7152,.0722];for(let c=0;c<3;c++)s+=w[c]*Math.max(0,L(a.data[i*4+c])-L(b.data[i*4+c]));Y[i]=s;}
const peak=Float32Array.from(Y).sort()[Math.floor(W*H*0.999)];
const big=[];let n=0;
for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;if(Math.max(Y[i],Y[i+1],Y[i+W])<peak*0.1)continue;n+=2;const s=Math.max(Math.abs(Y[i+1]-Y[i]),Math.abs(Y[i+W]-Y[i]))/peak;if(s>0.34)big.push([x,y,+s.toFixed(2),+(Y[i]/peak).toFixed(2)]);}
console.log('peak',peak,'n',n,'big',big.length);console.log(JSON.stringify(big.slice(0,60)));
for (const yy of [380, 422]) { const row=[]; for(let x=770;x<830;x++) row.push((Y[yy*W+x]/peak).toFixed(2)); console.log(yy, row.join(' ')); }
const px=(im,x,y)=>[im.data[(y*W+x)*4],im.data[(y*W+x)*4+1],im.data[(y*W+x)*4+2]];
console.log('mid', [774,776,778,780,782,784,786,790].map(x=>px(a,x,380).join(',')).join(' | '));
console.log('aft', [774,776,778,780,782,784,786,790].map(x=>px(b,x,380).join(',')).join(' | '));
