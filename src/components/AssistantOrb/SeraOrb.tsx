import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { AssistantStateType, AudioVisualizerData, ColorPaletteId } from '../../types';
import { getPaletteConfig } from '../../config/palettes';

interface SeraOrbProps {
  state: AssistantStateType;
  visualizerData: AudioVisualizerData;
  paletteId?: ColorPaletteId;
  customColor?: string;
}

function hexToRgb(hex: string): [number, number, number] {
  if (!hex) return [0.0, 0.9, 1.0];
  let value = hex.replace('#', '').trim();
  if (value.length === 3) {
    value = value.split('').map((c) => c + c).join('');
  }
  if (value.length !== 6) return [0.0, 0.9, 1.0];
  return [
    (parseInt(value.slice(0, 2), 16) || 0) / 255,
    (parseInt(value.slice(2, 4), 16) || 0) / 255,
    (parseInt(value.slice(4, 6), 16) || 0) / 255,
  ];
}

// --- Simplex Noise 3D GLSL ---
const simplexNoiseGLSL = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

// --- Vertex Shader: Gargantua Singularity & Original Spiral Galaxy Starfield ---
const seraOrbVertexShader = `
${simplexNoiseGLSL}

attribute vec3 aContractedPos;
attribute vec3 aExpandedPos;
attribute float aSize;
attribute float aPhase;
attribute float aSpeed;
attribute float aType; // 0=Equatorial Disk/Spiral Arm, 1=Photon Ring/Bulge, 2=Top Arch, 3=Bottom Arch, 4=Corona/Halo
attribute float aColorShift;

uniform float uTime;
uniform float uAudio;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uMorph; // 0.0 = Contracted Gargantua Black Hole (Speaking), 1.0 = Original Expanded Galaxy (Standby)
uniform float uWake;
uniform float uTone;

varying float vAlpha;
varying float vType;
varying float vDistance;
varying float vTwinkle;
varying float vColorShift;
varying float vDoppler;
varying float vDepthZ;
varying float vTransition;

void main() {
  vType = aType;
  vColorShift = aColorShift;

  // Staggered harmonic progress: outer stars collapse in layered waves
  float pOffset = fract(aPhase * 0.3183) * 0.16;
  float pt = clamp((uMorph - pOffset) / (1.0 - 0.16), 0.0, 1.0);
  float t = smoothstep(0.0, 1.0, pt);

  // Transition kinetic energy curve (peaks at mid-flight, exactly 0.0 at both endpoints)
  float transitionEnergy = sin(t * 3.14159);
  vTransition = transitionEnergy;

  // Relativistic Geodesic Inward Spiral
  vec3 posInterp = mix(aContractedPos, aExpandedPos, t);
  float currentRadius = max(0.35, length(posInterp.xz));
  float vortexSpeed = (2.2 + (3.4 / currentRadius)) * aSpeed;
  float vortexAngle = transitionEnergy * vortexSpeed;
  float cosV = cos(vortexAngle);
  float sinV = sin(vortexAngle);

  // 3D Tidal compression wave during transition
  float verticalTidal = sin(t * 3.14159) * sin(aPhase * 3.0) * 0.22 * (1.0 - t);

  vec3 posVortex = vec3(
    posInterp.x * cosV - posInterp.z * sinV,
    posInterp.y + verticalTidal,
    posInterp.x * sinV + posInterp.z * cosV
  );

  vec3 normDir = normalize(posVortex + vec3(0.0001));

  // Golden shockwave burst on wake detection
  posVortex += normDir * (uWake * 1.5 * exp(-uWake * 2.5));

  // Voice Harmonic Relativistic Waves
  float toneSpd = 1.0 + uTone * 1.4;
  float voiceWave = (uAudio * 0.15 + uBass * 0.12 + uTone * 0.10);
  float fluidNoise = snoise(posVortex * 2.2 + vec3(uTime * 0.55)) * (0.025 + voiceWave * 0.35);

  vec3 finalPos = posVortex + normDir * mix(fluidNoise, snoise(posVortex * 0.45 + vec3(uTime * 0.15)) * 0.04, t);

  // Keplerian Relativistic Rotation (Speaking) vs Smooth Galactic Flow (Standby)
  float distXZ = max(0.4, length(finalPos.xz));
  float spinSpd = mix((1.6 / sqrt(distXZ)) * toneSpd * 0.18, 0.045, t);
  float rotAngle = uTime * spinSpd * aSpeed;
  float cR = cos(rotAngle), sR = sin(rotAngle);

  vec3 rotated = vec3(
    finalPos.x * cR - finalPos.z * sR,
    finalPos.y,
    finalPos.x * sR + finalPos.z * cR
  );

  // Immersive Ambient Fluid Drift (Standby / Expanded State)
  vec3 ambientDrift = vec3(
    snoise(rotated * 0.12 + vec3(uTime * 0.08)),
    snoise(rotated * 0.12 + vec3(uTime * 0.09 + 10.0)),
    snoise(rotated * 0.12 + vec3(uTime * 0.07 + 20.0))
  ) * 1.5;

  rotated += mix(vec3(0.0), ambientDrift, t);

  // Galactic Perspective Tilt Angle
  float tilt = mix(0.20, 0.28, t);
  rotated = vec3(
    rotated.x,
    rotated.y * cos(tilt) - rotated.z * sin(tilt),
    rotated.y * sin(tilt) + rotated.z * cos(tilt)
  );

  vDistance = length(rotated);
  vDepthZ = rotated.z;

  // Relativistic Doppler Beaming
  float dopplerFactor = mix(clamp((rotated.x / 2.0) * 0.40 + 0.95, 0.65, 1.45), 1.0, t);
  vDoppler = dopplerFactor;

  float twinkle = (0.90 + sin(uTime * 2.5 + aPhase) * 0.15 + uAudio * 0.35) * dopplerFactor;
  vTwinkle = twinkle;

  vec4 mvPosition = modelViewMatrix * vec4(rotated, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Point sprite sizing with kinetic transition flare
  float pSize = aSize * (220.0 / -mvPosition.z) * (1.0 + uAudio * 0.20) * twinkle;
  if (aType > 0.5 && aType < 1.5) {
    pSize *= 1.35;
  } else if (aType >= 1.5 && aType < 3.5) {
    pSize *= 1.20;
  }
  pSize *= mix(1.15, 0.90, t);
  pSize *= (1.0 + transitionEnergy * 0.15 * aSpeed);
  gl_PointSize = clamp(pSize, 1.5, 12.0);

  // Soft depth fade
  float depthFade = clamp((-mvPosition.z - 1.2) / 6.5, 0.40, 1.0);
  vAlpha = clamp(0.80 + sin(uTime * 1.5 + aPhase) * 0.15 + uAudio * 0.35, 0.40, 1.0) * depthFade;
}
`;

// --- Fragment Shader: Volumetric Fluid Accretion & Doppler Shading ---
const seraOrbFragmentShader = `
uniform vec3 uColorCore;
uniform vec3 uColorArm;
uniform vec3 uColorOuter;
uniform float uAudio;
uniform float uWake;

varying float vAlpha;
varying float vType;
varying float vDistance;
varying float vTwinkle;
varying float vColorShift;
varying float vDoppler;
varying float vDepthZ;
varying float vTransition;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) discard;

  // Ultra-Smooth Volumetric Gaussian Falloff
  float coreGlow = exp(-dist * dist * 10.0);
  float haloGlow = exp(-dist * dist * 3.2) * 0.55;
  float softAura = exp(-dist * dist * 1.5) * 0.25;

  // 4-Point starburst glint for bright particles
  float spike = 0.0;
  if (vTwinkle > 0.90 || vType > 0.5) {
    float spikeH = max(0.0, 1.0 - abs(coord.x * 12.0)) * max(0.0, 1.0 - abs(coord.y * 3.5));
    float spikeV = max(0.0, 1.0 - abs(coord.y * 12.0)) * max(0.0, 1.0 - abs(coord.x * 3.5));
    spike = (spikeH + spikeV) * 0.30;
  }

  // 3-Tier Multi-Layer Palette Blending
  vec3 starColor = uColorCore;
  if (vType > 3.5) {
    starColor = mix(uColorOuter, vec3(1.0, 1.0, 1.0), vColorShift * 0.4);
  } else if (vType > 1.5) {
    starColor = mix(uColorArm, uColorCore, vColorShift * 0.6);
  } else if (vType > 0.5) {
    starColor = mix(vec3(1.0, 0.98, 0.92), uColorCore, 0.3);
  } else {
    starColor = mix(uColorCore, uColorArm, vColorShift);
  }

  // Relativistic Doppler Blue/Red Shift
  if (vDoppler > 1.0) {
    starColor = mix(starColor, vec3(0.75, 0.92, 1.0), (vDoppler - 1.0) * 1.4);
  } else {
    starColor = mix(starColor, vec3(1.0, 0.55, 0.35), (1.0 - vDoppler) * 1.2);
  }

  // Wake Shockwave Golden Shift
  if (uWake > 0.01) {
    starColor = mix(starColor, vec3(1.0, 0.95, 0.65), uWake * 0.85);
  }

  float intensity = (coreGlow * 1.6 + haloGlow * 0.8 + softAura * 0.4 + spike) * vAlpha;
  vec3 finalColor = starColor * (intensity * (1.35 + uAudio * 0.45));

  gl_FragColor = vec4(finalColor, clamp(intensity, 0.0, 1.0));
}
`;

export const SeraOrb: React.FC<SeraOrbProps> = React.memo(({
  state,
  visualizerData,
  paletteId,
  customColor,
}) => {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const dataRef = useRef(visualizerData);
  const paletteRef = useRef(getPaletteConfig(paletteId, customColor));

  const smoothIn = useRef(0);
  const smoothOut = useRef(0);

  // 2nd-Order Spring Dynamics for smooth morphing transitions
  const morphValue = useRef(0.95);
  const morphVelocity = useRef(0);

  // Wake burst intensity tracker
  const wakeIntensity = useRef(0);
  const prevState = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    dataRef.current = visualizerData;
  }, [visualizerData]);

  useEffect(() => {
    paletteRef.current = getPaletteConfig(paletteId, customColor);
  }, [paletteId, customColor]);

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 5.2);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const updateSize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    updateSize();
    window.addEventListener('resize', updateSize);

    const palette = paletteRef.current;
    const [c1r, c1g, c1b] = hexToRgb(palette.lamp);
    const [c2r, c2g, c2b] = hexToRgb(palette.secondary || palette.lamp);
    const [c3r, c3g, c3b] = hexToRgb(palette.tertiary || palette.secondary || palette.lamp);

    // 12,000 Particle Starfield
    const TOTAL_PARTICLES = 12000;
    const contractedPositions = new Float32Array(TOTAL_PARTICLES * 3);
    const expandedPositions = new Float32Array(TOTAL_PARTICLES * 3);
    const sizes = new Float32Array(TOTAL_PARTICLES);
    const phases = new Float32Array(TOTAL_PARTICLES);
    const speeds = new Float32Array(TOTAL_PARTICLES);
    const types = new Float32Array(TOTAL_PARTICLES);
    const colorShifts = new Float32Array(TOTAL_PARTICLES);

    for (let i = 0; i < TOTAL_PARTICLES; i++) {
      const idxRatio = i / TOTAL_PARTICLES;
      colorShifts[i] = Math.random();
      phases[i] = Math.random() * Math.PI * 2;
      speeds[i] = 0.85 + Math.random() * 0.35;

      let pType = 0;
      let cX = 0, cY = 0, cZ = 0;

      // ——— 1. CONTRACTED STATE: GARGANTUA BLACK HOLE (Speaking Mode) ———
      if (idxRatio < 0.20) {
        pType = 1;
        const angle = (i / (TOTAL_PARTICLES * 0.20)) * Math.PI * 2;
        const r = 0.78 + (Math.random() - 0.5) * 0.025;
        cX = Math.cos(angle) * r;
        cY = Math.sin(angle) * r;
        cZ = 0.02;
        sizes[i] = 0.038 + Math.random() * 0.022;

      } else if (idxRatio < 0.48) {
        pType = 2;
        const angle = ((i - TOTAL_PARTICLES * 0.20) / (TOTAL_PARTICLES * 0.28)) * Math.PI;
        const r = 0.80 + Math.pow(Math.random(), 0.65) * 0.62;
        cX = Math.cos(angle) * r;
        cY = Math.sin(angle) * r * (0.90 + 0.15 * Math.sin(angle));
        cZ = -Math.sin(angle) * 0.32 + (Math.random() - 0.5) * 0.04;
        sizes[i] = 0.032 + Math.random() * 0.018;

      } else if (idxRatio < 0.66) {
        pType = 3;
        const angle = Math.PI + ((i - TOTAL_PARTICLES * 0.48) / (TOTAL_PARTICLES * 0.18)) * Math.PI;
        const r = 0.80 + Math.pow(Math.random(), 0.65) * 0.52;
        cX = Math.cos(angle) * r;
        cY = Math.sin(angle) * r * 0.86;
        cZ = Math.sin(angle) * 0.32 + (Math.random() - 0.5) * 0.04;
        sizes[i] = 0.028 + Math.random() * 0.016;

      } else if (idxRatio < 0.92) {
        pType = 0;
        const angle = Math.random() * Math.PI * 2;
        const r = 0.80 + Math.pow(Math.random(), 0.50) * 2.10;
        cX = Math.cos(angle) * r;
        cY = (Math.random() - 0.5) * (0.03 + r * 0.015);
        cZ = Math.sin(angle) * r * 0.42;
        sizes[i] = 0.030 + Math.random() * 0.018;

      } else {
        pType = 4;
        const angle = Math.random() * Math.PI * 2;
        const r = 1.45 + Math.random() * 1.35;
        cX = Math.cos(angle) * r;
        cY = (Math.random() - 0.5) * 0.30;
        cZ = Math.sin(angle) * r * 0.40;
        sizes[i] = 0.020 + Math.random() * 0.015;
      }

      types[i] = pType;

      contractedPositions[i * 3]     = cX;
      contractedPositions[i * 3 + 1] = cY;
      contractedPositions[i * 3 + 2] = cZ;

      // ——— 2. EXPANDED STATE: FULLSCREEN AMBIENT STARFIELD (Standby Mode) ———
      let eX = 0, eY = 0, eZ = 0;
      eX = (Math.random() - 0.5) * 38.0;
      eY = (Math.random() - 0.5) * 22.0;
      eZ = (Math.random() - 0.5) * 14.0 - 1.0;

      expandedPositions[i * 3]     = eX;
      expandedPositions[i * 3 + 1] = eY;
      expandedPositions[i * 3 + 2] = eZ;
    }

    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(contractedPositions, 3));
    starGeometry.setAttribute('aContractedPos', new THREE.BufferAttribute(contractedPositions, 3));
    starGeometry.setAttribute('aExpandedPos', new THREE.BufferAttribute(expandedPositions, 3));
    starGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    starGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    starGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    starGeometry.setAttribute('aType', new THREE.BufferAttribute(types, 1));
    starGeometry.setAttribute('aColorShift', new THREE.BufferAttribute(colorShifts, 1));

    const starMaterial = new THREE.ShaderMaterial({
      vertexShader: seraOrbVertexShader,
      fragmentShader: seraOrbFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAudio: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uHigh: { value: 0 },
        uMorph: { value: 0.95 },
        uWake: { value: 0 },
        uTone: { value: 0 },
        uColorCore: { value: new THREE.Vector3(c1r, c1g, c1b) },
        uColorArm: { value: new THREE.Vector3(c2r, c2g, c2b) },
        uColorOuter: { value: new THREE.Vector3(c3r, c3g, c3b) },
      },
    });

    const starSystem = new THREE.Points(starGeometry, starMaterial);
    scene.add(starSystem);

    let lastTime = performance.now();
    let animationFrameId = 0;

    const animate = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;

      const currentState = stateRef.current;
      const { micLevel, speakerLevel, frequencies } = dataRef.current;
      const currentPalette = paletteRef.current;

      const binCount = frequencies.length || 64;
      let bass = 0, mid = 0, high = 0;
      for (let i = 0; i < binCount; i++) {
        const val = (frequencies[i] || 0) / 255;
        if (i < binCount * 0.25) bass += val;
        else if (i < binCount * 0.65) mid += val;
        else high += val;
      }
      bass = Math.min(1.5, (bass / (binCount * 0.25)) * 1.8);
      mid = Math.min(1.5, (mid / (binCount * 0.4)) * 1.8);
      high = Math.min(1.5, (high / (binCount * 0.35)) * 1.8);

      const targetIn = currentState === 'listening' ? Math.min(1, micLevel * 1.5) : 0;
      const targetOut = currentState === 'speaking' ? Math.min(1, speakerLevel * 1.5) : 0;
      const k = 1 - Math.pow(0.002, dt);
      smoothIn.current += (targetIn - smoothIn.current) * k;
      smoothOut.current += (targetOut - smoothOut.current) * k;

      const levelIn = smoothIn.current;
      const levelOut = smoothOut.current;
      const energy = Math.max(levelIn, levelOut);

      // Detect transition TO wake_word_detected
      if (currentState === 'wake_word_detected' && prevState.current !== 'wake_word_detected') {
        wakeIntensity.current = 1.0;
      }
      prevState.current = currentState;
      wakeIntensity.current = Math.max(0, wakeIntensity.current * 0.96);
      starMaterial.uniforms.uWake.value = wakeIntensity.current;

      // ——— STATE MORPH TARGETS ———
      let targetMorph = 0.95 + Math.sin(now * 0.0006) * 0.04;

      if (currentState === 'speaking') {
        targetMorph = 0.0;
      } else if (currentState === 'listening') {
        targetMorph = 0.94 + Math.min(0.05, levelIn * 0.06);
      } else if (currentState === 'wake_word_detected') {
        targetMorph = 0.90;
      } else if (currentState === 'connecting') {
        targetMorph = 0.92 + Math.sin(now * 0.003) * 0.04;
      }

      // Smooth 2nd-Order Spring Dynamics
      const springStiffness = 18.0;
      const springDamping = 7.2;
      const morphDisplacement = targetMorph - morphValue.current;
      const springForce = morphDisplacement * springStiffness - morphVelocity.current * springDamping;
      morphVelocity.current += springForce * dt;
      morphValue.current += morphVelocity.current * dt;

      const curMorph = Math.max(0.0, Math.min(1.0, morphValue.current));

      // Tone & Voice Energy
      const rawTone = Math.max(mid * 0.5 + high * 0.5, energy * 0.7);
      starMaterial.uniforms.uTone.value += (rawTone - starMaterial.uniforms.uTone.value) * Math.min(1, dt * 5);

      // Color Updates
      const [r1, g1, b1] = hexToRgb(currentPalette.lamp);
      const [r2, g2, b2] = hexToRgb(currentPalette.secondary || currentPalette.lamp);
      const [r3, g3, b3] = hexToRgb(currentPalette.tertiary || currentPalette.secondary || currentPalette.lamp);

      if (currentState === 'error') {
        starMaterial.uniforms.uColorCore.value.set(1.0, 0.15, 0.2);
        starMaterial.uniforms.uColorArm.value.set(0.8, 0.05, 0.1);
        starMaterial.uniforms.uColorOuter.value.set(0.6, 0.0, 0.1);
      } else if (currentState === 'speaking') {
        starMaterial.uniforms.uColorCore.value.set(r1 * 1.55, g1 * 1.55, b1 * 1.55);
        starMaterial.uniforms.uColorArm.value.set(r2 * 1.4, g2 * 1.4, b2 * 1.4);
        starMaterial.uniforms.uColorOuter.value.set(r3 * 1.2, g3 * 1.2, b3 * 1.2);
      } else if (currentState === 'listening') {
        starMaterial.uniforms.uColorCore.value.set(0.0, 0.95, 0.9);
        starMaterial.uniforms.uColorArm.value.set(r1 * 1.1, g1 * 1.1, b1 * 1.1);
        starMaterial.uniforms.uColorOuter.value.set(r2 * 0.9, g2 * 0.9, b2 * 0.9);
      } else if (currentState === 'wake_word_detected') {
        starMaterial.uniforms.uColorCore.value.set(1.0, 0.95, 0.7);
        starMaterial.uniforms.uColorArm.value.set(1.0, 0.8, 0.3);
        starMaterial.uniforms.uColorOuter.value.set(1.0, 0.6, 0.2);
      } else if (currentState === 'connecting') {
        const tColor = (Math.sin(now * 0.003) + 1.0) * 0.5;
        starMaterial.uniforms.uColorCore.value.set(
          r1 + (r2 - r1) * tColor,
          g1 + (g2 - g1) * tColor,
          b1 + (b2 - b1) * tColor,
        );
        starMaterial.uniforms.uColorArm.value.set(r2, g2, b2);
        starMaterial.uniforms.uColorOuter.value.set(r3, g3, b3);
      } else {
        starMaterial.uniforms.uColorCore.value.set(r1, g1, b1);
        starMaterial.uniforms.uColorArm.value.set(r2, g2, b2);
        starMaterial.uniforms.uColorOuter.value.set(r3, g3, b3);
      }

      starMaterial.uniforms.uTime.value = now * 0.001;
      starMaterial.uniforms.uAudio.value = energy;
      starMaterial.uniforms.uBass.value = bass;
      starMaterial.uniforms.uMid.value = mid;
      starMaterial.uniforms.uHigh.value = high;
      starMaterial.uniforms.uMorph.value = curMorph;

      renderer.render(scene, camera);
      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', updateSize);
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      starGeometry.dispose();
      starMaterial.dispose();
      // Dispose any textures / child materials before disposing the renderer.
      renderer.dispose();
      // Force a WebGL context loss so the GPU context is actually released.
      // `renderer.dispose()` only releases Three.js resources on the JS
      // side; the underlying WebGL context stays alive, and browsers cap
      // the number of live contexts per tab (~16). Repeated mount/unmount
      // of SeraOrb (e.g. via React StrictMode in dev, or page navigation)
      // would exhaust the context limit and silently break rendering.
      const loseCtx = renderer.getContext().getExtension('WEBGL_lose_context');
      if (loseCtx) loseCtx.loseContext();
    };
  }, []);

  return (
    <>
      {/* 3D Celestial WebGL Starfield Canvas */}
      <div
        ref={canvasContainerRef}
        className="pointer-events-none fixed inset-0 z-[-1] h-screen w-screen overflow-hidden"
        aria-hidden="true"
      />

      {/* Central Viewport Anchor: Ready for 3D Character/Avatar Base */}
      <div
        id="sera-orb-visual"
        aria-hidden="true"
        className="pointer-events-none relative z-10 flex aspect-square w-[min(84vw,320px)] select-none items-center justify-center rounded-full border-0 bg-transparent p-0 outline-none"
      />
    </>
  );
});
