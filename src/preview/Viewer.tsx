/**
 * Three.js preview of the generated mesh.
 *
 * docs/02-feature-spec.md F7.1: "The preview must render the *export* geometry,
 * not a separate approximation. If preview and export diverge, users lose trust
 * immediately." So this consumes the same MeshBundle the STL writer does —
 * there is no second geometry path.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MeshBundle } from '../geometry/types';

import { TERRAIN_BANDS } from '../geometry/palette';

export type ShadingMode = 'natural' | 'elevation' | 'slope' | 'wireframe';

interface ViewerProps {
  bundle: MeshBundle | null;
  shading: ShadingMode;
  autoSpin: boolean;
}

/** Print space is +Z up; three defaults to +Y up, so every camera must be told. */
const UP = new THREE.Vector3(0, 0, 1);

/** F7.1: "Default camera: south-facing, looking north, ~40° elevation." */
const CAMERA_ELEVATION_RAD = (40 * Math.PI) / 180;

/**
 * Above this angle between two faces, the edge between them is a real edge and
 * must not be smoothed away.
 *
 * Measured on the parts themselves: a prism's top meets its wall at 90 degrees
 * and an engraved groove at up to 116, while adjacent triangles on sampled
 * terrain sit well below 50. So 50 separates "this is a corner" from "this is a
 * surface" without faceting the relief.
 */
const CREASE_ANGLE_RAD = (50 * Math.PI) / 180;

/**
 * Vertices above which creasing is too expensive to be worth it.
 *
 * Creasing splits vertices — six-fold in practice — so a large part costs both
 * time and memory: measured at 152 ms and 36 MB for 252 k vertices, and 422 ms
 * and 97 MB for 676 k. Parts past this take the cheap route instead.
 */
const CREASE_VERTEX_BUDGET = 150_000;

export type ShadingPlan = 'crease' | 'smooth' | 'flat';

/**
 * How a part should be shaded.
 *
 * - `crease` splits normals at real edges only: relief stays smooth and corners
 *   stay corners. Correct for everything, but it splits vertices six-fold, so it
 *   is budgeted.
 * - `smooth` averages every face. Softens edges, but faceting a sampled surface
 *   looks far worse than a slightly soft rim.
 * - `flat` shades each face by its own normal, in the shader, for nothing. An
 *   extruded solid IS flat everywhere, so this is exactly right for one.
 */
export function chooseShading(name: string, vertexCount: number): ShadingPlan {
  if (vertexCount <= CREASE_VERTEX_BUDGET) return 'crease';
  // 'terrain' is the DEM alone; 'model' is the single-colour body, which
  // contains it. Both are surfaces first and solids second.
  return name === 'terrain' || name === 'model' ? 'smooth' : 'flat';
}

function terrainRamp(t: number, out: THREE.Color): THREE.Color {
  // Low ground green, through tan, to bare rock and snow.
  const stops: Array<[number, number, number, number]> = [
    [0.0, 0.29, 0.45, 0.28],
    [0.35, 0.55, 0.5, 0.32],
    [0.65, 0.63, 0.56, 0.47],
    [0.85, 0.72, 0.7, 0.67],
    [1.0, 0.97, 0.97, 0.97],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const f = (t - a[0]) / (b[0] - a[0] || 1);
      return out.setRGB(
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
        a[3] + (b[3] - a[3]) * f,
      );
    }
  }
  return out.setRGB(1, 1, 1);
}

/**
 * Paint a mesh from its per-triangle band indices.
 *
 * The geometry is de-indexed first. A vertex is shared by triangles on both
 * sides of a band boundary and can only carry one colour, so an indexed mesh
 * blurs every boundary into a gradient — which is the smooth ramp this feature
 * deliberately is not. Un-indexing costs vertices and buys a crisp snowline.
 */
function applyBandColours(geometry: THREE.BufferGeometry, bands: Uint8Array): void {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const count = flat.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  const colour = new THREE.Color();

  for (let t = 0; t < count / 3; t++) {
    colour.set(TERRAIN_BANDS[bands[t] ?? 0]?.color ?? '#888888');
    for (let k = 0; k < 3; k++) {
      const v = t * 3 + k;
      colours[v * 3] = colour.r;
      colours[v * 3 + 1] = colour.g;
      colours[v * 3 + 2] = colour.b;
    }
  }

  flat.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  if (flat !== geometry) {
    geometry.copy(flat);
  }
}

function buildColours(
  geometry: THREE.BufferGeometry,
  mode: ShadingMode,
  minZ: number,
  maxZ: number,
): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const colours = new Float32Array(position.count * 3);
  const colour = new THREE.Color();
  const span = maxZ - minZ || 1;

  for (let i = 0; i < position.count; i++) {
    if (mode === 'elevation') {
      terrainRamp((position.getZ(i) - minZ) / span, colour);
    } else {
      // Slope: angle of the surface normal away from vertical.
      const tilt = Math.acos(Math.min(1, Math.abs(normal.getZ(i))));
      const t = Math.min(1, tilt / (Math.PI / 2));
      colour.setRGB(0.25 + 0.7 * t, 0.7 - 0.45 * t, 0.35 - 0.2 * t);
    }
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
}

export function Viewer({ bundle, shading, autoSpin }: ViewerProps) {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<THREE.Scene | null>(null);
  const renderer = useRef<THREE.WebGLRenderer | null>(null);
  const camera = useRef<THREE.PerspectiveCamera | null>(null);
  const controls = useRef<OrbitControls | null>(null);
  const modelGroup = useRef<THREE.Group | null>(null);
  const spinning = useRef(autoSpin);
  spinning.current = autoSpin;

  useEffect(() => {
    const host = container.current;
    if (!host) return;

    const s = new THREE.Scene();
    s.background = new THREE.Color('#14161a');
    scene.current = s;

    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    cam.up.copy(UP);
    camera.current = cam;

    const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(r.domElement);
    renderer.current = r;

    const c = new OrbitControls(cam, r.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    controls.current = c;

    s.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-1, -1.4, 2.2);
    s.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(1.5, 1, 0.5);
    s.add(fill);

    const group = new THREE.Group();
    s.add(group);
    modelGroup.current = group;

    const resize = () => {
      const { clientWidth, clientHeight } = host;
      if (!clientWidth || !clientHeight) return;
      // updateStyle must stay on: with it off three sizes the drawing buffer but
      // leaves the canvas element with no CSS size, and it collapses to a
      // default 300x150 box inside a container that is telling it to fill.
      r.setSize(clientWidth, clientHeight);
      cam.aspect = clientWidth / clientHeight;
      cam.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    // docs/07-ui-spec.md accessibility: respect prefers-reduced-motion.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let last = performance.now();

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;

      if (spinning.current && !reduced.matches && modelGroup.current) {
        modelGroup.current.rotation.z += dt * 0.35;
      }
      c.update();
      r.render(s, cam);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      c.dispose();
      r.dispose();
      host.removeChild(r.domElement);
      scene.current = null;
      renderer.current = null;
      camera.current = null;
      controls.current = null;
      modelGroup.current = null;
    };
  }, []);

  useEffect(() => {
    const group = modelGroup.current;
    const cam = camera.current;
    const c = controls.current;
    if (!group || !cam || !c) return;

    for (const child of [...group.children]) {
      group.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((mat) => mat.dispose());
      else material?.dispose();
    }
    group.rotation.set(0, 0, 0);
    if (!bundle) return;

    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const part of bundle.parts) {
      for (let i = 2; i < part.positions.length; i += 3) {
        if (part.positions[i] < minZ) minZ = part.positions[i];
        if (part.positions[i] > maxZ) maxZ = part.positions[i];
      }
    }

    for (const part of bundle.parts) {
      let geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));

      // How the surface is shaded, decided per part.
      //
      // computeVertexNormals alone averages every face meeting at a vertex, and
      // extrudeDraped deliberately shares vertices between a solid's top face
      // and its vertical walls. Every one of the frame's vertices and every one
      // of an engraved label's therefore had a horizontal normal averaged with
      // a vertical one, and the viewer drew 90-degree edges as fillets — while
      // the STL, which stores a normal per facet, came out crisp. That mismatch
      // is exactly what F7.1 says must never happen.
      // See docs/08-pitfalls.md#the-viewer-smooths-away-every-hard-edge.
      const plan = chooseShading(part.name, part.positions.length / 3);
      if (plan === 'crease') {
        // Returns a NON-indexed geometry, which is why it is budgeted.
        geometry = toCreasedNormals(geometry, CREASE_ANGLE_RAD);
      } else {
        geometry.computeVertexNormals();
      }
      const flatShading = plan === 'flat';

      let material: THREE.Material;
      if (shading === 'wireframe') {
        material = new THREE.MeshBasicMaterial({ color: part.color, wireframe: true });
      } else if (shading === 'natural') {
        // A part carrying hypsometric bands is painted with them (F3.3). This
        // is the same band data the 3MF exports, so what the user sees here is
        // what a colour printer would make — the reason bands are discrete
        // rather than a smooth ramp.
        if (part.bands) {
          applyBandColours(geometry, part.bands);
          material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.92,
            metalness: 0,
            flatShading,
          });
        } else {
          material = new THREE.MeshStandardMaterial({
            color: part.color,
            roughness: 0.92,
            metalness: 0,
            flatShading,
          });
        }
      } else {
        buildColours(geometry, shading, minZ, maxZ);
        material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.92,
          metalness: 0,
          flatShading,
        });
      }

      group.add(new THREE.Mesh(geometry, material));
    }

    const [w, d] = bundle.stats.dimensions_mm;
    const radius = Math.max(w, d, maxZ - minZ) || 100;
    const distance = radius * 1.9;

    // South of the model, looking north, 40 degrees up.
    cam.position.set(
      0,
      -distance * Math.cos(CAMERA_ELEVATION_RAD),
      (maxZ + minZ) / 2 + distance * Math.sin(CAMERA_ELEVATION_RAD),
    );
    cam.near = Math.max(0.05, radius / 400);
    cam.far = radius * 40;
    cam.updateProjectionMatrix();

    c.target.set(0, 0, (maxZ + minZ) / 2);
    c.update();
  }, [bundle, shading]);

  return <div className="viewer" ref={container} />;
}
