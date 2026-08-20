/**
 * MapLibre map: basemap, live terrain, route overlay and the selection tools.
 *
 * The map is created once and held in a ref; React only ever pushes data into
 * its sources. Re-creating a WebGL map on every render is the standard way to
 * make a map app feel broken.
 */
import { useCallback, useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Route } from '../data/gpx/types';
import type { SelectionShape } from '../geometry/selection';
import { BASEMAPS, demSource } from './basemaps';
import {
  finishPolygon,
  moveShape,
  pointsToGeoJSON,
  resizeShape,
  shapeFromDrag,
  shapeHandles,
  shapeToGeoJSON,
  type DrawTool,
  type LonLat,
} from './draw';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

interface MapViewProps {
  basemapId: string;
  datasetId: string;
  terrain3d: boolean;
  shape: SelectionShape | null;
  tool: DrawTool | null;
  routes: Route[];
  onShapeChange: (shape: SelectionShape) => void;
  onToolFinished: () => void;
  onCursor: (lonLat: LonLat) => void;
}

type Interaction =
  | { kind: 'idle' }
  | { kind: 'drawing'; start: LonLat }
  | { kind: 'polygon'; points: LonLat[] }
  | { kind: 'moving'; last: LonLat }
  | { kind: 'resizing' };

export function MapView({
  basemapId,
  datasetId,
  terrain3d,
  shape,
  tool,
  routes,
  onShapeChange,
  onToolFinished,
  onCursor,
}: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);

  // Interaction and the newest props, read from map event handlers that are
  // registered once and must not close over stale values.
  const interaction = useRef<Interaction>({ kind: 'idle' });
  const live = useRef({ shape, tool, onShapeChange, onToolFinished, onCursor });
  live.current = { shape, tool, onShapeChange, onToolFinished, onCursor };

  const setData = useCallback((id: string, data: GeoJSON.GeoJSON) => {
    const source = map.current?.getSource(id) as maplibregl.GeoJSONSource | undefined;
    source?.setData(data);
  }, []);

  /** Sources and layers are wiped by setStyle, so this runs on every style load. */
  const addOverlays = useCallback(() => {
    const m = map.current;
    if (!m) return;

    if (!m.getSource('dem')) {
      m.addSource('dem', demSource(datasetId));
      m.addLayer({
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: { 'hillshade-exaggeration': 0.35 },
      });
    }

    for (const [id, data] of [
      ['routes', EMPTY],
      ['selection', EMPTY],
      ['draft', EMPTY],
      ['handles', EMPTY],
    ] as const) {
      if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data });
    }

    if (!m.getLayer('selection-fill')) {
      m.addLayer({
        id: 'selection-fill',
        type: 'fill',
        source: 'selection',
        paint: { 'fill-color': '#ff7a45', 'fill-opacity': 0.12 },
      });
      m.addLayer({
        id: 'selection-line',
        type: 'line',
        source: 'selection',
        paint: { 'line-color': '#ff7a45', 'line-width': 2 },
      });
      m.addLayer({
        id: 'draft-line',
        type: 'line',
        source: 'draft',
        paint: { 'line-color': '#ff7a45', 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      m.addLayer({
        id: 'routes-line',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': ['case', ['get', 'visible'], 1, 0.25],
        },
      });
      m.addLayer({
        id: 'selection-handles',
        type: 'circle',
        source: 'handles',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ff7a45',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
    }

    ready.current = true;
  }, [datasetId]);

  // --- create the map once --------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const style = BASEMAPS.find((b) => b.id === basemapId) ?? BASEMAPS[0];
    const m = new maplibregl.Map({
      container: container.current,
      style: style.styleUrl,
      center: [73.05, 33.72],
      zoom: 9,
      attributionControl: { compact: false },
    });
    map.current = m;

    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('style.load', addOverlays);

    const toLonLat = (e: MapMouseEvent): LonLat => [e.lngLat.lng, e.lngLat.lat];

    m.on('mousemove', (e: MapMouseEvent) => {
      live.current.onCursor(toLonLat(e));

      const state = interaction.current;
      const { tool: activeTool, shape: current } = live.current;

      if (state.kind === 'drawing' && activeTool) {
        const preview = shapeFromDrag(activeTool, state.start, toLonLat(e));
        if (preview) setData('selection', shapeToGeoJSON(preview));
      } else if (state.kind === 'polygon') {
        setData('draft', pointsToGeoJSON([...state.points, toLonLat(e)]));
      } else if (state.kind === 'moving' && current) {
        const [lon, lat] = toLonLat(e);
        const next = moveShape(current, lon - state.last[0], lat - state.last[1]);
        interaction.current = { kind: 'moving', last: [lon, lat] };
        live.current.onShapeChange(next);
      } else if (state.kind === 'resizing' && current) {
        live.current.onShapeChange(resizeShape(current, toLonLat(e)));
      }
    });

    m.on('mousedown', (e: MapMouseEvent) => {
      const { tool: activeTool, shape: current } = live.current;

      if (activeTool && activeTool !== 'polygon') {
        interaction.current = { kind: 'drawing', start: toLonLat(e) };
        m.dragPan.disable();
        return;
      }

      if (!activeTool && current) {
        const hits = m.queryRenderedFeatures(e.point, { layers: ['selection-handles'] });
        const role = hits[0]?.properties?.['role'];
        if (role === 'centre') {
          interaction.current = { kind: 'moving', last: toLonLat(e) };
          m.dragPan.disable();
        } else if (role === 'resize') {
          interaction.current = { kind: 'resizing' };
          m.dragPan.disable();
        }
      }
    });

    m.on('mouseup', (e: MapMouseEvent) => {
      const state = interaction.current;
      const { tool: activeTool } = live.current;

      if (state.kind === 'drawing' && activeTool) {
        const next = shapeFromDrag(activeTool, state.start, toLonLat(e));
        if (next) {
          live.current.onShapeChange(next);
          live.current.onToolFinished();
        }
      }

      if (state.kind !== 'polygon') {
        interaction.current = { kind: 'idle' };
        m.dragPan.enable();
      }
    });

    // Polygon is click-to-add rather than drag.
    m.on('click', (e: MapMouseEvent) => {
      if (live.current.tool !== 'polygon') return;
      const state = interaction.current;
      const points = state.kind === 'polygon' ? [...state.points, toLonLat(e)] : [toLonLat(e)];
      interaction.current = { kind: 'polygon', points };
      setData('draft', pointsToGeoJSON(points));
    });

    m.on('dblclick', (e: MapMouseEvent) => {
      const state = interaction.current;
      if (live.current.tool !== 'polygon' || state.kind !== 'polygon') return;
      e.preventDefault();

      const next = finishPolygon(state.points);
      interaction.current = { kind: 'idle' };
      setData('draft', EMPTY);
      if (next) {
        live.current.onShapeChange(next);
        live.current.onToolFinished();
      }
    });

    return () => {
      m.remove();
      map.current = null;
      ready.current = false;
    };
    // Created once, deliberately. Prop changes are pushed through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc cancels an in-progress draw, per docs/07-ui-spec.md keyboard section.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      interaction.current = { kind: 'idle' };
      setData('draft', EMPTY);
      map.current?.dragPan.enable();
      live.current.onToolFinished();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setData]);

  useEffect(() => {
    const m = map.current;
    const style = BASEMAPS.find((b) => b.id === basemapId);
    if (!m || !style) return;
    ready.current = false;
    m.setStyle(style.styleUrl);
  }, [basemapId]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    if (terrain3d) {
      m.setTerrain({ source: 'dem', exaggeration: 1.4 });
      if (m.getPitch() < 20) m.easeTo({ pitch: 55, duration: 600 });
    } else {
      m.setTerrain(null);
      m.easeTo({ pitch: 0, duration: 600 });
    }
  }, [terrain3d, basemapId]);

  useEffect(() => {
    if (!ready.current) return;
    setData(
      'selection',
      shape ? { type: 'FeatureCollection', features: [shapeToGeoJSON(shape)] } : EMPTY,
    );

    if (!shape) {
      setData('handles', EMPTY);
      return;
    }
    const handles = shapeHandles(shape);
    setData('handles', {
      type: 'FeatureCollection',
      features: (['centre', 'resize'] as const).map((role) => ({
        type: 'Feature',
        properties: { role },
        geometry: { type: 'Point', coordinates: handles[role] },
      })),
    });
  }, [shape, setData, basemapId]);

  useEffect(() => {
    if (!ready.current) return;
    setData('routes', {
      type: 'FeatureCollection',
      features: routes.map((route) => ({
        type: 'Feature',
        properties: { color: route.style.color, visible: route.style.visible },
        geometry: {
          type: 'LineString',
          coordinates: route.points.map((p) => [p.lon, p.lat]),
        },
      })),
    });
  }, [routes, setData, basemapId]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.getCanvas().style.cursor = tool ? 'crosshair' : '';
  }, [tool]);

  return <div className="mapview" ref={container} />;
}

/** Fly the map to a bounding box. Exposed so "Fit to routes" can move the view too. */
export function fitBoundsOn(m: maplibregl.Map | null, bbox: [number, number, number, number]) {
  m?.fitBounds(bbox, { padding: 48, duration: 700 });
}
