/* The orb. A living, breathing presence that shows the screen is awake without a
   single word. It swells and swirls with the sound in the room, flares when it
   recognises a song, then shrinks into the status light at the top of the screen
   while the lyrics play. One WebGL fragment shader, no libraries, runs offline. */
const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2  uRes;
uniform float uTime, uLevel, uCatch, uRest;
uniform vec2  uCenter;
uniform float uSize;
uniform vec2  uPokeDir;   // where it was touched, as a direction from the centre
uniform float uDent;      // spring: + pushed in, - overshooting out
uniform float uJig;       // jelly wobble after release
uniform float uRip;       // 0..1 age of the ripple
uniform vec2  uRipPos;    // ripple origin, in orb units
uniform float uAtmos;     // 0..1: listening hard, light fills the room
uniform float uBurst;     // 0..1: age of the "found it" explosion
uniform vec2  uBurstC;    // where the explosion happens, in screen units
uniform float uAmb;       // 0..1: the ShemenMusic aura spreading behind the lyrics
uniform float uKick;      // (kept for compatibility; no longer driven)
uniform float uConf;      // 0..1: how sure it is that it has found the song
uniform vec2  uJigDir;    // axis the jelly squashes along
uniform vec3  uT0, uT1, uT2;  // the song's three cover colours

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i = 0; i < 4; i++){ v += a*noise(p); p = p*2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes) / min(uRes.x, uRes.y);
  vec2 p  = (uv - uCenter) / uSize;
  float r = length(p);
  float e = clamp(uLevel, 0.0, 1.0);
  float T = uTime;
  float t = T * (0.38 + e*0.95);             // always moving; sound makes it quicker

  // shape: a sphere that gently morphs and swells with sound
  vec2 dir = r > 0.0001 ? p / r : vec2(1.0, 0.0);
  float R = 0.20 + 0.010*sin(T*0.8) + e*0.04 + uCatch*0.05 + uKick*0.034;
  // near-perfect sphere: only sound and touch deform it
  float wob = (noise(dir*1.2 + vec2(t*0.5, -t*0.4)) - 0.5) * (0.004 + e*0.018);
  float cd  = dot(dir, uPokeDir);                              // 1 where it was touched
  float dent = uDent * 0.075 * exp(-(1.0 - cd) * 5.5);         // local dent under the finger
  float cj   = dot(dir, uJigDir);
  float jig  = uJig * 0.046 * (2.0*cj*cj - 1.0)                // squash and stretch, like jelly
             + uJig * 0.012 * (4.0*cj*cj*cj - 3.0*cj);           // a second, three-lobed wobble
  float edge = R + wob - dent + jig;
  float d = r - edge;
  float x = clamp(r / edge, 0.0, 1.0);
  float z = sqrt(max(0.0, 1.0 - x*x));        // height on the dome

  // GLASS: the inside is seen through a lens, compressed toward the rim
  vec2 lp = p * (0.55 + 0.45*z) / edge + uPokeDir * uDent * 0.28;

  // ALIVE: five saturated lights orbiting inside the glass. Light ADDS: where they
  // overlap it goes white-hot, which is what makes it look magical rather than muddy.
  vec3 cob   = vec3(0.12, 0.26, 1.00);
  vec3 brand = vec3(0.00, 0.55, 1.00);
  vec3 sky   = vec3(0.25, 0.85, 1.00);
  vec3 ice   = vec3(0.80, 0.95, 1.00);
  vec3 yel   = vec3(1.00, 0.80, 0.08);
  vec3 indigo= vec3(0.30, 0.18, 1.00);
  float gather = 1.0 - 0.45*uConf;
  vec2 L1 = 0.46*gather*vec2(cos(t*0.90), sin(t*1.17));
  vec2 L2 = 0.46*gather*vec2(cos(t*0.71 + 2.1), sin(t*0.93 + 1.2));
  vec2 L3 = 0.40*gather*vec2(cos(t*1.23 + 4.0), sin(t*0.81 + 3.3));
  vec2 L4 = 0.36*gather*vec2(cos(t*0.57 + 5.2), sin(t*1.31 + 0.4));
  vec2 L5 = 0.30*gather*vec2(cos(t*1.05 + 1.1), sin(t*0.66 + 5.0));
  vec3 light = brand * exp(-dot(lp-L1, lp-L1) * 4.6) * 0.95
             + sky   * exp(-dot(lp-L2, lp-L2) * 5.2) * 0.85
             + yel   * exp(-dot(lp-L3, lp-L3) * 5.0) * 1.25
             + indigo* exp(-dot(lp-L4, lp-L4) * 4.8) * 0.95
             + cob   * exp(-dot(lp-L5, lp-L5) * 5.4) * 0.9;
  vec3 col = normalize(light + 1e-3) * 0.9;          // hue of whatever light is here, for the rim
  vec3 inner = cob*0.20 + light * (0.78 + e*0.6);    // deep blue ambient, never black space

  // depth: a deeper core and a bright rim, the way light behaves in a glass ball
  float fres = pow(1.0 - z, 2.2);
  inner = inner * (0.80 + 0.20*z) + mix(col, ice, 0.55) * fres * 1.05;

  // the rim splits colour very slightly, like real glass dispersion
  float rR = exp(-abs(r - edge*1.005) * 130.0);
  float rG = exp(-abs(r - edge)       * 130.0);
  float rB = exp(-abs(r - edge*0.995) * 130.0);
  vec3 rim = vec3(rR*0.85, rG, rB*1.15) * (0.85 + e);

  // a crisp window highlight and a soft reflection underneath
  vec2 s1 = p/edge - vec2(-0.38, 0.42);  float spec  = exp(-dot(s1, s1) * 22.0) * 0.95;
  vec2 s2 = p/edge - vec2( 0.30, -0.38); float spec2 = exp(-dot(s2, s2) * 12.0) * 0.20;

  // MAGIC: a few sparkles twinkling inside the glass
  vec2 g = lp * 9.0; vec2 gi = floor(g); vec2 gf = fract(g) - 0.5;
  float h = hash(gi);
  float tw = pow(max(0.0, sin(T*(1.4 + h*2.2) + h*20.0)), 18.0);
  float spark = step(0.82, h) * tw * exp(-dot(gf, gf) * 60.0) * z * (0.9 + e);

  vec2 rq = p/edge - uRipPos;
  float rr = uRip * 1.6;
  float ripple = exp(-pow((length(rq) - rr) * 9.0, 2.0)) * pow(1.0 - uRip, 2.0) * step(0.0001, uRip) * step(uRip, 0.999);

  float px = 1.0 / max(1.0, min(uRes.x, uRes.y) * uSize);
  float inside = smoothstep(px, -px, d);
  vec3 orb = inner * (1.0 + uConf*0.45) + rim + vec3(spec) + sky*spec2 + vec3(spark)*ice + ice * ripple * 0.9;

  // PHOTOREAL: studio softboxes reflected in the curved glass, light focused through the ball
  // into a caustic on its lower inside, and a thin-film shimmer at the rim
  vec3 N  = normalize(vec3(p/edge, z));
  vec3 Rf = reflect(vec3(0.0, 0.0, -1.0), N);
  // soft rounded reflections: a curved ball never shows a straight edge or a corner
  vec2  sb1 = (Rf.xy - vec2(-0.16, 0.74)) / vec2(0.30, 0.16);
  float box1 = exp(-pow(dot(sb1, sb1), 1.4) * 1.6);
  vec2  sb2 = (Rf.xy - vec2(-0.58, 0.10)) / vec2(0.12, 0.30);
  float box2 = exp(-pow(dot(sb2, sb2), 1.4) * 1.6);
  vec2  cq = (p/edge - vec2(0.10, -0.56)) * vec2(1.0, 2.3);
  float caustic = exp(-dot(cq, cq) * 8.0);
  vec3  irid = 0.5 + 0.5*cos(6.2831*(vec3(0.0, 0.33, 0.67) + fres*1.5 + T*0.04));
  orb += vec3(0.92, 0.96, 1.0)*(box1*0.34 + box2*0.12) + ice*caustic*(0.55 + e*0.6) + irid*fres*0.20;

  // AURA: a large two-layer bloom that turns slowly and breathes, swelling with sound
  float ang = atan(p.y, p.x);
  vec2 ed = dir * 0.95;                                   // sample the lights just inside the edge
  vec3 edgeLight = brand * exp(-dot(ed-L1, ed-L1) * 2.0) + sky * exp(-dot(ed-L2, ed-L2) * 2.2)
                 + yel * exp(-dot(ed-L3, ed-L3) * 2.6) + indigo * exp(-dot(ed-L4, ed-L4) * 2.2);
  vec3 auraCol = mix(brand, edgeLight / (0.35 + length(edgeLight)), 0.75);
  float dd = max(d, 0.0);
  float aura = (exp(-dd*4.2)*0.42 + exp(-dd*12.0)*0.60)
             * (0.86 + 0.14*sin(T*1.3)) * (0.8 + e*1.2 + uCatch*1.6 + uKick*1.4);
  vec3 outside = auraCol * aura + rim * (1.0 - inside) * 0.6;

  vec3 c = mix(outside, orb, inside);

  // SEARCHING: the orb's light spills out and fills the whole screen, pulsing with the music
  vec2 ap = uv - uCenter;
  float ar = length(ap), aang = atan(ap.y, ap.x);
  float rays = pow(0.5 + 0.5*sin(aang*7.0 + T*0.45 + 3.0*fbm(ap*2.0 + T*0.1)), 5.0);
  float haze = exp(-ar*1.25);
  vec3 atmosCol = mix(brand, sky, 0.5 + 0.5*sin(aang*2.0 - T*0.3));
  atmosCol += yel * (0.10 + 0.08*sin(T*0.7));        // yellow ADDED, never blended into grey-green
  c += atmosCol * (haze*0.30 + rays*haze*0.24) * uAtmos * (0.55 + e*1.2);
  vec2 mg = uv*14.0 + vec2(T*0.15, -T*0.10); vec2 mf = fract(mg) - 0.5;
  float mh = hash(floor(mg));
  c += ice * step(0.93, mh) * exp(-dot(mf, mf)*40.0) * (0.5 + 0.5*sin(T*2.0 + mh*30.0)) * uAtmos * 0.55;

  // THINKING: a substantial band around the orb that fills clockwise from the top as it
  // gets surer, over a visible empty track, with a rounded leading edge and a soft glow
  float ringR = edge * 1.26;
  float band  = 0.017;                                        // thick, not a hairline
  float rd    = abs(r - ringR);
  float body  = smoothstep(band, band*0.55, rd);              // crisp solid band
  float glowR = exp(-pow(rd / (band*2.6), 2.0));              // soft light around it
  float ang0 = atan(p.x, p.y); float frac = (ang0 < 0.0 ? ang0 + 6.28318 : ang0) / 6.28318;
  float filled = smoothstep(uConf + 0.003, uConf - 0.003, frac);
  float ea = uConf * 6.28318;                                 // rounded cap where the fill ends
  vec2  capP = ringR * vec2(sin(ea), cos(ea));
  float cap  = smoothstep(band, band*0.55, length(p - capP));
  float on   = max(body * filled, cap * step(0.02, uConf));
  vec3  ringCol = mix(sky, yel, smoothstep(0.35, 0.95, uConf));
  float show = 0.0;   // no ring: the orb itself shows progress (lights gather, it brightens, the room lights)
  c += (ringCol * (on * 1.05 + glowR * filled * 0.35) + vec3(0.55, 0.7, 0.85) * body * (1.0 - filled) * 0.13) * show;

  // FOUND: a soft bloom and one gentle ring outward; an arrival, not a flash
  vec2 bp = uv - uBurstC; float br = length(bp), B = uBurst;
  float alive = step(0.0001, B) * step(B, 0.999);
  float ring  = exp(-pow((br - B*1.7) * (11.0 - 5.0*B), 2.0)) * pow(1.0 - B, 1.4) * alive;
  float flash = pow(1.0 - B, 4.0) * exp(-br*1.4) * alive;
  float bang  = atan(bp.y, bp.x);
  float hb    = hash(vec2(floor(bang * 36.0 / 6.2832), 3.0));
  float shard = smoothstep(0.72, 1.0, hb) * exp(-pow((br - B*(0.8 + hb*1.3)) * 16.0, 2.0)) * pow(1.0 - B, 2.0) * alive;
  c += ice*ring*0.75 + mix(sky, yel, 0.55)*shard*0.35 + vec3(1.0, 0.96, 0.85)*flash*0.14;
  // AMBIENT: the album cover's colours, melted into slow moving light, Apple Music style
  float at = T * 0.055;
  vec2 b1 = vec2(-0.55 + 0.28*sin(at*1.3),  0.30 + 0.22*cos(at*1.1));
  vec2 b2 = vec2( 0.55 + 0.24*cos(at*0.9), -0.25 + 0.26*sin(at*1.2));
  vec2 b3 = vec2( 0.05 + 0.38*sin(at*0.7 + 2.0), 0.05 + 0.32*cos(at*0.8 + 1.0));
  float g1 = exp(-dot(uv-b1, uv-b1) * 0.95), g2 = exp(-dot(uv-b2, uv-b2) * 0.95), g3 = exp(-dot(uv-b3, uv-b3) * 1.4);
  vec3 amb = (uT0*g1 + uT1*g2 + uT2*g3) / (g1 + g2 + g3 + 0.30);
  amb *= (0.80 + 0.35*fbm(uv*1.4 + at*2.0)) * (0.90 + 0.30*e + uKick*0.35);
  amb *= 0.62 * smoothstep(1.9, 0.1, length(uv * vec2(0.8, 1.0)));      // fills the screen, words still read
  c += amb * uAmb;

  c *= mix(1.0, 0.72, uRest);
  c += uCatch * exp(-r*r*14.0) * vec3(1.0, 0.95, 0.80) * 0.7;
  c = c / (1.0 + c * 0.22);                  // gentle shoulder that keeps the colour vivid
  gl_FragColor = vec4(c, 1.0);
}`;

export class Orb {
  constructor(canvas){
    this.c = canvas;
    const gl = canvas.getContext('webgl', {antialias:false, alpha:false,
                                           powerPreference:'high-performance'});
    this.gl = gl;
    if(!gl){ this.dead = true; return; }
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for(const n of ['uRes','uTime','uLevel','uCatch','uRest','uCenter','uSize','uPokeDir','uDent','uJig','uRip','uRipPos','uAtmos','uBurst','uBurstC','uAmb','uT0','uT1','uT2','uKick','uJigDir','uConf'])
      this.u[n] = gl.getUniformLocation(prog, n);
    this.level = 0; this.levelIn = 0; this.catchV = 0; this.rest = 1;
    this.center = [0, 0]; this.size = 1;
    this.target = {center:[0,0], size:1, rest:1};
    this.pokeDir = [0, 1]; this.dent = 0; this.dentV = 0; this.jig = 0; this.jigV = 0;
    this.pressed = false; this.rip = 0; this.ripPos = [0, 0];
    this.atmos = 0; this.atmosTarget = 0; this.burst = 0; this.burstC = [0, 0];
    this.amb = 0; this.ambTarget = 0; this.kickV = 0; this.jigDir = [0, 1];
    this.conf = 0; this.confTarget = 0;
    this.tint = [[0,0.40,0.60],[0.10,0.22,0.78],[0.25,0.70,1.00]]; this.tintTarget = this.tint.map(c => c.slice());
    this.t0 = performance.now();
    this.resize(); addEventListener('resize', () => this.resize());
    const loop = () => { this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  resize(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);     // full retina sharpness, capped at 2x
    this.c.width  = Math.round(innerWidth * dpr);
    this.c.height = Math.round(innerHeight * dpr);
    this.gl && this.gl.viewport(0, 0, this.c.width, this.c.height);
  }
  /* touch: press dents it under the finger, release lets it spring and jiggle back */
  toOrbSpace(clientX, clientY){
    const m = Math.min(innerWidth, innerHeight);
    const ux = (clientX - innerWidth/2)/m, uy = (innerHeight/2 - clientY)/m;
    return [(ux - this.center[0]) / this.size, (uy - this.center[1]) / this.size];
  }
  press(clientX, clientY){
    const [x, y] = this.toOrbSpace(clientX, clientY), r = Math.hypot(x, y);
    if(r > 0.45) return false;                         // only when you touch the orb or its glow
    this.pokeDir = r > 1e-4 ? [x/r, y/r] : [0, 1];
    this.pressed = true; this.dentV += 2.2;
    this.rip = 0.0001; this.ripPos = [x/0.2, y/0.2];
    return true;
  }
  release(){
    if(!this.pressed) return;
    this.pressed = false; this.jigDir = this.pokeDir.slice(); this.jigV += 12.0 * Math.max(0.35, this.dent);
  }
  attach(el){
    el.addEventListener('pointerdown', e => { if(this.press(e.clientX, e.clientY)) e.stopPropagation(); });
    addEventListener('pointerup', () => this.release());
    addEventListener('pointercancel', () => this.release());
  }
  setLevel(v){ this.levelIn = Math.max(0, Math.min(1, v)); }
  flare(){ this.catchV = 1; }
  /* a kick drum: pump, flash, and set the jelly wobbling top to bottom */
  kick(strength){
    const k = Math.max(0, Math.min(1, strength));
    this.kickV = Math.max(this.kickV, k);
    this.jigDir = [0, 1]; this.jigV -= 7.0 * k;
  }
  setConfidence(v){ this.confTarget = Math.max(0, Math.min(1, v)); }
  // doubt: the song on screen stopped matching. In the corner the orb swells 30%, calmly (no
  // flashing: people preach over music), and settles back when the song is confirmed again
  setDoubt(on){ this.doubtTarget = on ? 1 : 0; }
  setAmbient(v){ this.ambTarget = Math.max(0, Math.min(1, v)); }
  setTint(t){ if(t && t.length === 3) this.tintTarget = t.map(c => c.slice(0, 3)); }
  setAtmos(v){ this.atmosTarget = Math.max(0, Math.min(1, v)); }
  explode(){ this.catchV = 1; this.burst = 0.0001; this.burstC = [this.center[0], this.center[1]]; this.atmos = Math.max(this.atmos, 0.8); this.atmosTarget = 0; }
  toRest(){ this.target = {center:[0,0], size:1, rest:1}; }
  toListening(){ this.target = {center:[0,0], size:1, rest:0}; }
  toStatus(cx, cy){ this.target = {center:[cx, cy], size:0.06, rest:0}; }
  draw(){
    if(this.dead) return;
    const gl = this.gl, now = performance.now();
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000); this.last = now;
    const li = this.levelIn;
    this.level += (li - this.level) * (li > this.level ? 0.35 : 0.06);   // fast attack, slow release
    this.catchV *= Math.pow(0.12, dt);
    const k = 1 - Math.pow(0.0008, dt);                                    // critically damped glide
    this.center[0] += (this.target.center[0] - this.center[0]) * k;
    this.center[1] += (this.target.center[1] - this.center[1]) * k;
    this.size += (this.target.size - this.size) * k;
    this.doubt = (this.doubt || 0) + ((this.doubtTarget || 0) - (this.doubt || 0)) * Math.min(1, dt * 3.0);
    this.rest += (this.target.rest - this.rest) * (1 - Math.pow(0.02, dt));
    // underdamped springs: it overshoots and wobbles, like jelly
    const dTarget = this.pressed ? 1.0 : 0.0;
    this.dentV += (-(this.dent - dTarget) * 140 - this.dentV * 9) * dt;  this.dent += this.dentV * dt;
    this.jigV  += (-this.jig * 80 - this.jigV * 2.1) * dt;                this.jig  += this.jigV * dt;
    if(this.rip > 0){ this.rip += dt / 1.1; if(this.rip >= 1) this.rip = 0; }
    const up = this.atmosTarget > this.atmos;
    this.atmos += (this.atmosTarget - this.atmos) * (1 - Math.pow(up ? 0.22 : 0.06, dt));
    if(this.burst > 0){ this.burst += dt / 1.15; if(this.burst >= 1) this.burst = 0; }
    this.amb += (this.ambTarget - this.amb) * (1 - Math.pow(0.12, dt));
    this.kickV *= Math.pow(0.0015, dt);
    // confidence climbs steadily and falls away slowly, so the ring never flickers
    this.conf += (this.confTarget - this.conf) * (1 - Math.pow(this.confTarget > this.conf ? 0.08 : 0.35, dt));
    const kt = 1 - Math.pow(0.25, dt);                       // colours drift to the new cover
    for(let i=0;i<3;i++) for(let j=0;j<3;j++) this.tint[i][j] += (this.tintTarget[i][j] - this.tint[i][j]) * kt;
    gl.uniform2f(this.u.uRes, this.c.width, this.c.height);
    gl.uniform1f(this.u.uTime, (now - this.t0) / 1000);
    gl.uniform1f(this.u.uLevel, this.level);
    gl.uniform1f(this.u.uCatch, this.catchV);
    gl.uniform1f(this.u.uRest, this.rest);
    gl.uniform2f(this.u.uCenter, this.center[0], this.center[1]);
    const swell = this.target.size < 0.5 ? 1 + 0.3 * (this.doubt || 0) : 1;     // only in the corner
    gl.uniform1f(this.u.uSize, this.size * swell * (1 - Math.max(0, this.dent) * 0.035));
    gl.uniform2f(this.u.uPokeDir, this.pokeDir[0], this.pokeDir[1]);
    gl.uniform1f(this.u.uDent, this.dent);
    gl.uniform1f(this.u.uJig, this.jig);
    gl.uniform1f(this.u.uRip, this.rip);
    gl.uniform2f(this.u.uRipPos, this.ripPos[0], this.ripPos[1]);
    gl.uniform1f(this.u.uAtmos, this.atmos);
    gl.uniform1f(this.u.uBurst, this.burst);
    gl.uniform2f(this.u.uBurstC, this.burstC[0], this.burstC[1]);
    gl.uniform1f(this.u.uAmb, this.amb);
    gl.uniform1f(this.u.uKick, 0.0);
    gl.uniform1f(this.u.uConf, this.conf);
    gl.uniform2f(this.u.uJigDir, this.jigDir[0], this.jigDir[1]);
    gl.uniform3fv(this.u.uT0, this.tint[0]); gl.uniform3fv(this.u.uT1, this.tint[1]); gl.uniform3fv(this.u.uT2, this.tint[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
