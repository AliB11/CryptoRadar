/* ============================================================
   RadarEngine — موتور تحلیل مشترک مرورگر/سرور (UMD)
   همان الگوی protection.js: یک پیاده‌سازی، دو مصرف.
   مرورگر: <script src="lib/engine.js"> پیش از terminal.js — توابع را
   روی globalThis می‌گذارد تا فراخوانی‌های terminal.js بدون تغییر کار کنند.
   سرور:  require('./lib/engine.js') — فقط module.exports (بدون آلودگی global).
   شامل: آمار پایه، اندیکاتورها، امتیازدهی، واگرایی، تحلیل/نهایی‌سازی سکه،
   بک‌تست walk-forward، مونت‌کارلو، پایداری زمانی و هشت‌عامل هم‌گرایی.
   ============================================================ */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
    // In CommonJS (server/tests) keep the global scope clean; browser classic
    // scripts below spread the API so bare identifiers in terminal.js resolve.
    if (root && (typeof document !== 'undefined' || (typeof window !== 'undefined' && window.document))) {
      spread(root, api);
    }
  } else if (root) {
    spread(root, api);
  }
  function spread(target, src) {
    for (const k of Object.keys(src)) {
      try { target[k] = src[k]; } catch (e) { /* frozen/read-only globals */ }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- آمار پایه ---------- */
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function mean(a){return a&&a.length?a.reduce((s,x)=>s+x,0)/a.length:0;}
  function std(a){if(!a||a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length);}
  function variance(a){if(!a||a.length<2)return 0;const m=mean(a);return a.reduce((s,x)=>s+(x-m)**2,0)/a.length;}
  function cov(x,y){const n=Math.min(x.length,y.length);if(n<2)return 0;const mx=mean(x),my=mean(y);let s=0;
    for(let i=0;i<n;i++)s+=(x[i]-mx)*(y[i]-my);return s/n;}
  function pearson(x,y){const n=Math.min(x&&x.length||0,y&&y.length||0);if(n<2)return 0;let sx=0,sy=0,sxx=0,syy=0,sxy=0;
    for(let i=0;i<n;i++){const a=x[i],b=y[i];sx+=a;sy+=b;sxx+=a*a;syy+=b*b;sxy+=a*b;}
    const den=Math.sqrt((n*sxx-sx*sx)*(n*syy-sy*sy));return den? (n*sxy-sx*sy)/den:0;}
  function slopeLog(a){const n=a.length;let sx=0,sy=0,sxy=0,sxx=0;
    for(let i=0;i<n;i++){const y=Math.log(a[i]);sx+=i;sy+=y;sxy+=i*y;sxx+=i*i;}
    return (n*sxy-sx*sy)/((n*sxx-sx*sx)||1e-12);}

  /* ---------- اندیکاتورها ---------- */
  function emaSeries(a,n){const k=2/(n+1),out=new Array(a.length);let e=a[0];
    for(let i=0;i<a.length;i++){e=i?a[i]*k+e*(1-k):a[0];out[i]=e;}return out;}
  function rsiSeries(c,n=14){const out=new Array(c.length).fill(50);let g=0,l=0;
    for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],up=Math.max(d,0),dn=Math.max(-d,0);
      if(i<=n){g+=up;l+=dn;if(i===n){g/=n;l/=n;out[i]=100-100/(1+g/(l||1e-12));}}
      else{g=(g*(n-1)+up)/n;l=(l*(n-1)+dn)/n;out[i]=100-100/(1+g/(l||1e-12));}}
    return out;}
  function computeSeries(sp){
    const e12=emaSeries(sp,12),e26=emaSeries(sp,26);
    const macd=e12.map((v,i)=>v-e26[i]);
    const sig=emaSeries(macd,9);
    const hist=macd.map((v,i)=>v-sig[i]);
    return {n:sp.length,e12,e26,macd,sig,hist,rsi:rsiSeries(sp,14)};}
  function scoreAt(sp,S,i,vol){
    const p=sp[i],r=S.rsi[i];
    const rsiC = r<=30 ? 60+(30-r)*1.2 : r>=70 ? -(60+(r-70)*1.2) : (r-50)*0.4;
    const r24=p/sp[Math.max(0,i-24)]-1, rAll=p/sp[0]-1;
    const momC=clamp(0.6*(r24/(vol*Math.sqrt(24)+1e-12))+0.4*(rAll/(vol*Math.sqrt(Math.max(1,i))+1e-12)),-2.2,2.2)*42;
    const trendC=clamp((p/S.e26[i]-1)/(vol*Math.sqrt(26)+1e-12),-2.5,2.5)*36;
    const macdC=clamp(S.hist[i]/(p*vol*Math.sqrt(9)+1e-12),-2,2)*45;
    const w=sp.slice(Math.max(0,i-19),i+1),m=mean(w),sd=std(w);
    const z=(p-m)/(2*sd+1e-12);
    const bollC=clamp(-z,-2,2)*30;
    return {score:Math.round(0.2*rsiC+0.25*momC+0.2*trendC+0.25*macdC+0.1*bollC),
            comps:{rsiC,momC,trendC,macdC,bollC,z,r}};}

  /* موتور سبک مونت‌کارلو — تک‌گذر و بدون تخصیص آرایه */
  function scoreLite(sp,vol){
    const n=sp.length;
    const k12=2/13,k26=2/27,k9=2/10;
    let e12=sp[0],e26=sp[0],sig=0,g=0,l=0,rsi=50,macd=0,hist=0;
    let sum=0,sum2=0;
    for(let i=0;i<n;i++){
      const p=sp[i];
      if(i>0){e12=p*k12+e12*(1-k12);e26=p*k26+e26*(1-k26);}
      macd=e12-e26;
      sig=i>0?macd*k9+sig*(1-k9):macd;
      hist=macd-sig;
      if(i>0){
        const d=p-sp[i-1],up=d>0?d:0,dn=d<0?-d:0;
        if(i<=14){g+=up;l+=dn;if(i===14){g/=14;l/=14;rsi=100-100/(1+g/(l||1e-12));}}
        else{g=(g*13+up)/14;l=(l*13+dn)/14;rsi=100-100/(1+g/(l||1e-12));}
      }
      if(i<20){sum+=p;sum2+=p*p;}
      else{const old=sp[i-20];sum+=p-old;sum2+=p*p-old*old;}
    }
    const p=sp[n-1],r=rsi;
    const rsiC=r<=30?60+(30-r)*1.2:r>=70?-(60+(r-70)*1.2):(r-50)*0.4;
    const r24=p/sp[Math.max(0,n-25)]-1, rAll=p/sp[0]-1;
    const momC=clamp(0.6*(r24/(vol*Math.sqrt(24)+1e-12))+0.4*(rAll/(vol*Math.sqrt(Math.max(1,n-1))+1e-12)),-2.2,2.2)*42;
    const trendC=clamp((p/e26-1)/(vol*Math.sqrt(26)+1e-12),-2.5,2.5)*36;
    const macdC=clamp(hist/(p*vol*Math.sqrt(9)+1e-12),-2,2)*45;
    const m=sum/20,sd=Math.sqrt(Math.max(0,sum2/20-m*m));
    const z=(p-m)/(2*sd+1e-12);
    const bollC=clamp(-z,-2,2)*30;
    return {score:Math.round(0.2*rsiC+0.25*momC+0.2*trendC+0.25*macdC+0.1*bollC),e12,e26};
  }

  /* ---------- آشکارساز واگرایی ---------- */
  function findPivots(a,k){
    const out=[];
    for(let i=k;i<a.length-k;i++){
      let isMax=true,isMin=true;
      for(let j=i-k;j<=i+k;j++){
        if(j===i)continue;
        if(a[j]>a[i])isMax=false;
        if(a[j]<a[i])isMin=false;
      }
      if(isMax)out.push({i,v:a[i],t:1});
      else if(isMin)out.push({i,v:a[i],t:0});
    }
    return out;
  }
  function detectDivergence(sp,S){
    const n=S.n;
    if(n<70)return null;
    const W=Math.min(96,n-30),off=n-W;
    if(W<40)return null;
    const pp=findPivots(sp.slice(off),5);
    if(pp.length<2)return null;
    const lows=pp.filter(p=>!p.t),highs=pp.filter(p=>p.t===1);
    const cands=[];
    const consider=(arr,type)=>{
      for(let k=arr.length-1;k>0;k--){
        const b=arr[k],a=arr[k-1];
        if(b.i-a.i<6)continue;
        if(b.i<W-42)continue;
        const i1=off+a.i,i2=off+b.i;
        if(i1<20)continue;
        const pd=(b.v-a.v)/(Math.abs(a.v)||1e-12);
        const rd=S.rsi[i2]-S.rsi[i1];
        let hit=null;
        if(type==='low'){
          if(pd<-0.004&&rd>3)hit={kind:'bull',hidden:false,i1,i2,pd,rd};
          else if(pd>0.004&&rd<-3)hit={kind:'bull',hidden:true,i1,i2,pd,rd};
        }else{
          if(pd>0.004&&rd<-3)hit={kind:'bear',hidden:false,i1,i2,pd,rd};
          else if(pd<-0.004&&rd>3)hit={kind:'bear',hidden:true,i1,i2,pd,rd};
        }
        if(hit){cands.push(hit);return;}
      }
    };
    consider(lows,'low');consider(highs,'high');
    if(!cands.length)return null;
    const reg=cands.filter(d=>!d.hidden);
    const d=(reg.length?reg:cands).sort((x,y)=>y.i2-x.i2)[0];
    const macdAgree=d.kind==='bull'?(S.hist[d.i2]>S.hist[d.i1]):(S.hist[d.i2]<S.hist[d.i1]);
    const barsAgo=n-1-d.i2;
    const strength=clamp(0.35+0.25*Math.min(1,Math.abs(d.rd)/12)+0.2*Math.min(1,Math.abs(d.pd)/0.08)+(macdAgree?0.2:0)-0.15*Math.min(1,barsAgo/60),0.25,1);
    return {...d,macdAgree,barsAgo,strength,p1:sp[d.i1],p2:sp[d.i2],r1:S.rsi[d.i1],r2:S.rsi[d.i2]};
  }

  /* ---------- تحلیل سکه ---------- */
  function analyzeCoin(c){
    const sp=c.spark,n=sp.length;c.price=sp[n-1];
    const rets=[];for(let i=1;i<n;i++)rets.push(sp[i]/sp[i-1]-1);
    c.rets=rets; c.vol=std(rets.slice(-120))||0.002;
    const S=c.S=computeSeries(sp);
    const head=scoreAt(sp,S,n-1,c.vol);
    c.rawScore=head.score;c.comps=head.comps;
    c.div=detectDivergence(sp,S);
    const w=sp.slice(-20),mid=mean(w),sd=std(w);
    c.ind={r:S.rsi[n-1],e12:S.e12[n-1],e26:S.e26[n-1],hist:S.hist[n-1],histPrev:S.hist[n-2],
           mid,sd,z:(c.price-mid)/(2*sd+1e-12),bw:4*sd/mid,
           r24:sp[n-1]/sp[Math.max(0,n-25)]-1,r7:sp[n-1]/sp[0]-1,slope24:slopeLog(sp.slice(-24))};
    c.ch24h=c.ind.r24*100; c.r7=c.ind.r7;
    c.squeeze=std(rets.slice(-48))/(std(rets.slice(96,144))||1e-9);
    c.proneRaw=Math.abs(head.score)<15 && c.squeeze<0.72 && Math.abs(c.ind.z)<0.3;
    const H=Math.max(...sp),L=Math.min(...sp),P=(H+L+c.price)/3;
    c.piv={H,L,P,R1:2*P-L,R2:P+(H-L),S1:2*P-H,S2:P-(H-L)};
    c.atrPct=c.vol*Math.sqrt(24)*100;
    if(c.ch1h==null)c.ch1h=(sp[n-1]/sp[n-2]-1)*100;
    if(c.ch30d==null)c.ch30d=null;
  }

  function finalizeCoin(c,btc){
    let score=c.rawScore,anchor=0,corr=null;
    if(btc&&btc!==c){
      corr=pearson(c.rets,btc.rets);
      if(corr>0.35&&Math.abs(btc.finalScore)>=15&&Math.abs(score)>=15&&Math.sign(score)!==Math.sign(btc.finalScore)){
        const k=0.3*corr*Math.min(Math.abs(btc.finalScore),60)/60;
        anchor=Math.round(score*(1-k))-score;score=Math.round(score*(1-k));}
      c.beta=variance(btc.rets)>1e-12?cov(c.rets,btc.rets)/variance(btc.rets):null;
    }else{c.beta=null;}
    c.corr=corr;c.anchorAdj=anchor;c.finalScore=score;
    c.sharpe=c.r7/(c.vol*Math.sqrt(167)+1e-12);
    c.agree=btc&&btc!==c?(Math.abs(score)>=15&&Math.abs(btc.finalScore)>=15&&Math.sign(score)===Math.sign(btc.finalScore)):false;
    if(c.proneRaw){c.label='PRONE';c.proneDir=Math.sign(c.S.e12[c.S.n-1]-c.S.e26[c.S.n-1])||1;}
    else c.label=score>=45?'BUY2':score>=15?'BUY':score<=-45?'SELL2':score<=-15?'SELL':'NEU';
    let wins=0,tot=0;const sp=c.spark,S=c.S,n=sp.length,vol=c.vol;
    for(let i=60;i<n-12;i+=2){
      const s=scoreAt(sp,S,i,vol).score;
      if(Math.abs(s)<25)continue;
      const fwd=sp[i+12]/sp[i]-1,thr=Math.max(0.0035,vol*Math.sqrt(12)*0.5);
      if(s>0?fwd>thr:fwd<-thr)wins++;tot++;}
    c.bt=tot>=6?{wins,tot,rate:wins/tot}:null;
    let conf=48+Math.abs(score)*0.32;
    conf+=c.agree?9:-7;
    if(c.bt)conf+=(c.bt.rate-0.5)*40;
    conf-=clamp((c.atrPct-4)*1.4,0,12);
    c.conf=clamp(Math.round(conf),8,94);
    const s24=c.ind.slope24*24,sig24=c.vol*Math.sqrt(24);
    const f=clamp(s24*0.45,-2.2*sig24,2.2*sig24);
    c.forecast24={exp:c.price*(1+f),dir:Math.sign(f)};
  }

  /* ---------- بک‌تست walk-forward ---------- */
  function finishTrade(o){
    let ret;
    if(o.t1Hit)ret=0.5*((o.tp1-o.entry)/o.entry)+0.5*((o.exit-o.entry)/o.entry);
    else ret=(o.exit-o.entry)/o.entry;
    if(!o.long)ret=-ret;
    return {entryI:o.i,exitI:o.exitI,long:o.long,entry:o.entry,exit:o.exit,sl0:o.sl0,
            tp1:o.tp1,tp2:o.tp2,t1Hit:o.t1Hit,slDist:o.slDist,score:o.score,ret,bars:o.exitI-o.i};
  }

  function backtestCoin(c,th){
    const sp=c.spark,S=c.S,n=sp.length,vol=c.vol;
    const slDist=clamp(2.2*vol*Math.sqrt(6),0.006,0.15);
    const trades=[];let open=null,cool=0;
    for(let i=60;i<n;i++){
      if(open){
        const p=sp[i];let done=false;
        if(open.long){
          if(!open.t1Hit&&p>=open.tp1){open.t1Hit=true;open.sl=open.entry;}
          if(p<=open.sl){open.exit=open.sl;done=true;}
          else if(p>=open.tp2){open.exit=open.tp2;done=true;}
          else if(i-open.i>=48){open.exit=p;done=true;}
        }else{
          if(!open.t1Hit&&p<=open.tp1){open.t1Hit=true;open.sl=open.entry;}
          if(p>=open.sl){open.exit=open.sl;done=true;}
          else if(p<=open.tp2){open.exit=open.tp2;done=true;}
          else if(i-open.i>=48){open.exit=p;done=true;}
        }
        if(done){open.exitI=i;trades.push(finishTrade(open));cool=i+6;open=null;}
        continue;
      }
      if(i<cool)continue;
      const sc=scoreAt(sp,S,i,vol).score;
      if(Math.abs(sc)>=th){
        const long=sc>0,e=sp[i];
        open={i,long,entry:e,slDist,
          sl0:long?e*(1-slDist):e*(1+slDist),
          sl:long?e*(1-slDist):e*(1+slDist),
          tp1:long?e*(1+slDist):e*(1-slDist),
          tp2:long?e*(1+2.2*slDist):e*(1-2.2*slDist),
          t1Hit:false,score:sc};
      }
    }
    if(open){open.exit=sp[n-1];open.exitI=n-1;trades.push(finishTrade(open));}
    return trades;
  }

  /* خلاصه‌ی بک‌تست به تفکیک برچسب — منبع واحد نرخ برد برای «لبه» */
  function summarizeClasses(trades){
    const classes={};
    for(const t of trades){const L=t.coin&&t.coin.label;
      if(!L)continue;
      const cl=classes[L]=classes[L]||{n:0,wins:0,sw:0,sl:0};
      cl.n++;if(t.ret>0){cl.wins++;cl.sw+=t.ret;}else cl.sl+=-t.ret;}
    for(const L in classes){const cl=classes[L];
      cl.winRate=cl.wins/cl.n;cl.avgRet=(cl.sw-cl.sl)/cl.n;
      cl.pf=cl.sl>0?cl.sw/cl.sl:(cl.sw>0?Infinity:0);}
    return classes;
  }

  /* عامل «لبه»: نرخ برد کلاس حداقل ۸ معامله — همان قاعده‌ی confluenceAll قدیمی */
  function classEdge(classes){
    const cw={};
    if(classes)
      for(const L of ['BUY2','BUY','PRONE','SELL','SELL2']){
        const cl=classes[L];
        if(cl&&cl.n>=8)cw[L]=cl.winRate;}
    return cw;
  }

  /* ---------- کیفیت سیگنال ---------- */
  function mcRobustness(c,sims=10){
    const sp=c.spark,n=sp.length;
    const prone=c.label==='PRONE';
    const dir=prone?c.proneDir:(Math.sign(c.finalScore)||1);
    let keep=0;
    const st=Math.max(1,n-60);
    // Repeated data must not change an execution-grade signal just because a
    // second tab rolled different Monte Carlo noise. Seed by the full series.
    let seed=2166136261;
    for(const ch of String(c.id)+'|'+sp.join(',')){seed^=ch.charCodeAt(0);seed=Math.imul(seed,16777619);}
    const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return(seed+1)/4294967297;};
    const noise=()=>Math.sqrt(-2*Math.log(random()))*Math.cos(2*Math.PI*random());
    for(let s=0;s<sims;s++){
      const sp2=sp.slice();
      for(let i=st;i<n;i++)sp2[i]*=1+noise()*c.vol*0.7;
      const r=scoreLite(sp2,c.vol);
      const d=prone?(Math.sign(r.e12-r.e26)||1):(Math.sign(r.score)||1);
      if(d===dir)keep++;
    }
    return keep/sims;
  }

  function timeStability(c){
    const sp=c.spark,S=c.S,n=sp.length;
    const dir=c.label==='PRONE'?c.proneDir:(Math.sign(c.finalScore)||1);
    let m=0;const K=12;
    for(let i=n-K;i<n;i++){
      const d=c.label==='PRONE'?(Math.sign(S.e12[i]-S.e26[i])||1):Math.sign(scoreAt(sp,S,i,c.vol).score);
      if(d===dir)m++;
    }
    return m/K;
  }

  /* ---------- هشت عامل هم‌گرایی ---------- */
  const CONFKEYS=['trend','macd','rsi','boll','anchor','stable','robust','edge'];

  /* btc = شیء سکه‌ی بیت‌کوین (ممکن است null باشد).
     لنگر: سکه با بیت‌کوین هم‌جهت است، یا خودِ بیت‌کوین است (همیشه با خودش
     هم‌جهت!)، یا لنگر در خنثی‌ست (|score|<15) و نمی‌تواند قضاوت کند. */
  function confluenceOf(c,cw,btc){
    const I=c.ind,prone=c.label==='PRONE';
    const dir=prone?c.proneDir:(Math.sign(c.finalScore)||1);
    const long=dir>=0;
    const f={};
    f.trend=prone?(long?I.e12>=I.e26:I.e12<=I.e26)
                 :(long?(c.price>I.e26&&I.e12>=I.e26):(c.price<I.e26&&I.e12<=I.e26));
    f.macd=long?I.hist>0:I.hist<0;
    f.rsi=prone?(I.r>=35&&I.r<=65):(long?(I.r>=42&&I.r<=68):(I.r>=32&&I.r<=58));
    f.boll=prone?Math.abs(I.z)<0.5:(long?I.z<0.8:I.z>-0.8);
    f.anchor=!btc||c===btc||c.agree||Math.abs(btc.finalScore)<15;
    f.stable=(c.stability||0)>=0.7;
    f.robust=(c.robust||0)>=0.65;
    f.edge=((c.bt&&c.bt.rate>=0.55)||(cw&&cw[c.label]!=null&&cw[c.label]>=0.55));
    return f;
  }

  function gradeOf(confCount){
    return confCount>=8?'A+':confCount===7?'A':confCount===6?'B+':confCount===5?'B':confCount===4?'C':'D';
  }

  /* ---------- خط تولید کامل برای سرور (بدون رابط کاربری) ----------
     ورودی: آرایه‌ی سکه‌ها با spark (۱۶۸ نقطه‌ی ساعتی)، id، sym، mcap...
     خروجی: همان سکه‌ها با label/finalScore/bt/robust/stability/conf8/grade. */
  function evaluateUniverse(coins,options){
    const opts=options||{};
    const th=opts.th!=null?opts.th:25;
    if(!Array.isArray(coins)||!coins.length)
      return {coins:[],btc:null,classEdge:{},trades:[]};
    const btc=coins.find(c=>c.id==='bitcoin')||coins.find(c=>c.sym==='BTC')||null;
    // بیت‌کوین باید پیش از بقیه نهایی‌سازی شود تا لنگر/هم‌جهتی بقیه درست باشد.
    if(btc){analyzeCoin(btc);finalizeCoin(btc,null);btc.robust=mcRobustness(btc);}
    for(const c of coins){
      if(c===btc)continue;
      analyzeCoin(c);finalizeCoin(c,btc);c.robust=mcRobustness(c);
    }
    const trades=[];
    for(const c of coins)
      for(const t of backtestCoin(c,th)){t.coin=c;trades.push(t);}
    const cw=classEdge(summarizeClasses(trades));
    for(const c of coins){
      if(c.label==='NEU'){c.grade='—';c.confCount=null;c.conf8=null;c.stability=null;continue;}
      c.stability=timeStability(c);
      const f=confluenceOf(c,cw,btc);
      c.conf8=f;
      c.confCount=CONFKEYS.filter(k=>f[k]).length;
      c.grade=gradeOf(c.confCount);
    }
    return {coins,btc,classEdge:cw,trades};
  }

  return Object.freeze({
    clamp, mean, std, variance, cov, pearson, slopeLog,
    emaSeries, rsiSeries, computeSeries, scoreAt, scoreLite,
    findPivots, detectDivergence,
    analyzeCoin, finalizeCoin,
    finishTrade, backtestCoin, summarizeClasses, classEdge,
    mcRobustness, timeStability,
    CONFKEYS, confluenceOf, gradeOf, evaluateUniverse
  });
});
