/**
 * MapLibre map: basemap, live terrain, route overlay and the selection tools.
 *
 * The map is created once and held in a ref; React only ever pushes data into
 * its sources. Re-creating a WebGL map on every render is the standard way to
 * make a map app feel broken.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Route } from '../data/gpx/types';
import { selectionBBox, type SelectionShape } from '../geometry/selection';
import { BASEMAPS, demSource } from './basemaps';
import {
  finishPolygon,
  isClickTool,
  moveShape,
  pointsToGeoJSON,
  resizeShape,
  shapeFromDrag,
  shapeHandles,
  shapeToGeoJSON,
  type DrawTool,
  type LonLat,
} from './draw';
import { deleteVertex, insertVertex, moveVertex, vertexHandles } from './editPath';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

interface MapViewProps {
  basemapId: string;
  /** Bumped when the selection was set from outside the map and the view should follow. */
  fitNonce: number;
  datasetId: string;
  terrain3d: boolean;
  shape: SelectionShape | null;
  tool: DrawTool | null;
  routes: Route[];
  /** OSM features the model will contain, or null when no preview is loaded. */
  featurePreview: GeoJSON.FeatureCollection | null;
  onShapeChange: (shape: SelectionShape) => void;
  /** A hand-drawn route, finished (docs/02-feature-spec.md F1.3). */
  onRouteDrawn: (points: LonLat[]) => void;
  /** The route whose vertices are being edited, or null (F1.3). */
  editingRouteId: string | null;
  /** A vertex was moved, inserted or deleted. Fires per pointer move while dragging. */
  onRouteEdited: (id: string, points: LonLat[]) => void;
  /** Something the map declined to do, in words. */
  onNotice: (text: string) => void;
  /** Somewhere to fly the view, or null. Set by "My location". */
  flyTo: LonLat | null;
  onToolFinished: () => void;
  onCursor: (lonLat: LonLat) => void;
}

/** Within a few pixels on screen, at the current zoom. */
function samePlace(m: maplibregl.Map, a: LonLat, b: LonLat): boolean {
  const pa = m.project(a);
  const pb = m.project(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) < 4;
}

type Interaction =
  | { kind: 'idle' }
  | { kind: 'drawing'; start: LonLat }
  | { kind: 'points'; points: LonLat[] }
  | { kind: 'moving'; last: LonLat }
  | { kind: 'resizing' }
  /** Dragging one vertex of the route being edited. */
  | { kind: 'vertex'; index: number };

export function MapView({
  basemapId,
  fitNonce,
  datasetId,
  terrain3d,
  shape,
  tool,
  routes,
  featurePreview,
  onShapeChange,
  onRouteDrawn,
  editingRouteId,
  onRouteEdited,
  onNotice,
  flyTo,
  onToolFinished,
  onCursor,
}: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);

  // Interaction and the newest props, read from map event handlers that are
  // registered once and must not close over stale values.
  const interaction = useRef<Interaction>({ kind: 'idle' });

  /** The line being edited, as bare pairs, or null. */
  const editPoints = useMemo<LonLat[] | null>(() => {
    if (!editingRouteId) return null;
    const route = routes.find((r) => r.id === editingRouteId);
    return route ? route.points.map((p) => [p.lon, p.lat] as LonLat) : null;
  }, [routes, editingRouteId]);

  const live = useRef({
    shape,
    tool,
    editingRouteId,
    editPoints,
    onShapeChange,
    onRouteDrawn,
    onRouteEdited,
    onNotice,
    onToolFinished,
    onCursor,
  });
  live.current = {
    shape,
    tool,
    editingRouteId,
    editPoints,
    onShapeChange,
    onRouteDrawn,
    onRouteEdited,
    onNotice,
    onToolFinished,
    onCursor,
  };

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

      // Insert the hillshade UNDER the basemap's roads and labels. addLayer with
      // no beforeId puts a layer on top of everything, and a hillshade stretched
      // over the whole style renders as a uniform pale wash that hides the map
      // completely — it looks exactly like a basemap that failed to load.
      const firstLineLayer = (m.getStyle()?.layers ?? []).find(
        (l) => l.type === 'line' || l.type === 'symbol',
      )?.id;

      m.addLayer(
        {
          id: 'hillshade',
          type: 'hillshade',
          source: 'dem',
          paint: { 'hillshade-exaggeration': 0.3 },
        },
        firstLineLayer,
      );
    }

    for (const [id, data] of [
      ['features', EMPTY],
      ['routes', EMPTY],
      ['selection', EMPTY],
      ['draft', EMPTY],
      ['handles', EMPTY],
      ['vertices', EMPTY],
    ] as const) {
      if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data });
    }

    if (!m.getLayer('selection-fill')) {
      // Feature preview sits below the selection outline and the routes, so
      // neither is ever hidden by a dense street network.
      // Width follows the PRINTED width, not the real one, so the hierarchy on
      // screen is the hierarchy that gets built.
      m.addLayer({
        id: 'features-excluded',
        type: 'line',
        source: 'features',
        filter: ['!', ['get', 'included']],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.35,
          'line-dasharray': [1.5, 1.5],
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            9, ['max', 0.5, ['*', ['get', 'width_mm'], 1.2]],
            16, ['max', 1.5, ['*', ['get', 'width_mm'], 9]],
          ],
        },
      });
      m.addLayer({
        id: 'features-line',
        type: 'line',
        source: 'features',
        filter: ['get', 'included'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.9,
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            9, ['max', 0.6, ['*', ['get', 'width_mm'], 1.5]],
            16, ['max', 2, ['*', ['get', 'width_mm'], 11]],
          ],
        },
      });
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
      // Route vertex editing (F1.3). Midpoints are hollow and smaller than
      // vertices, so "drag me" and "click to add one here" read differently
      // without a legend. Both sit above the route line they belong to.
      m.addLayer({
        id: 'vertex-midpoints',
        type: 'circle',
        source: 'vertices',
        filter: ['==', ['get', 'role'], 'midpoint'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#ffffff',
          'circle-opacity': 0.55,
          'circle-stroke-color': '#1f7a3d',
          'circle-stroke-width': 1.5,
        },
      });
      m.addLayer({
        id: 'route-vertices',
        type: 'circle',
        source: 'vertices',
        filter: ['==', ['get', 'role'], 'vertex'],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'end'], null], 5.5, 7],
          'circle-color': [
            'match',
            ['coalesce', ['get', 'end'], 'mid'],
            'start', '#1f7a3d',
            'finish', '#b02a2a',
            '#ffffff',
          ],
          'circle-stroke-color': '#1f7a3d',
          'circle-stroke-width': 2,
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

    if (import.meta.env.DEV) {
      (window as unknown as { __map?: maplibregl.Map }).__map = m;
    }

    // A basemap that fails to load is currently a silent white rectangle. Say so.
    m.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.error('[map]', e.error?.message ?? e);
    });

    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('style.load', addOverlays);

    const toLonLat = (e: MapMouseEvent): LonLat => [e.lngLat.lng, e.lngLat.lat];

    /** Delete a vertex, or explain why not. Shared by right-click and alt-click. */
    const removeVertexAt = (id: string, points: LonLat[], index: number) => {
      const next = deleteVertex(points, index);
      if (next) {
        live.current.onRouteEdited(id, next);
      } else {
        live.current.onNotice('A route needs at least two points. Delete the route instead.');
      }
    };

    m.on('mousemove', (e: MapMouseEvent) => {
      live.current.onCursor(toLonLat(e));

      const state = interaction.current;
      if (state.kind === 'idle' && !live.current.tool && live.current.editingRouteId) {
        const layers = ['route-vertices', 'vertex-midpoints'].filter((l) => m.getLayer(l));
        const over = m.queryRenderedFeatures(e.point, { layers }).length > 0;
        m.getCanvas().style.cursor = over ? 'move' : '';
      }

      const { tool: activeTool, shape: current } = live.current;

      if (state.kind === 'drawing' && activeTool) {
        const preview = shapeFromDrag(activeTool, state.start, toLonLat(e));
        if (preview) setData('selection', shapeToGeoJSON(preview));
      } else if (state.kind === 'points') {
        setData('draft', pointsToGeoJSON([...state.points, toLonLat(e)]));
      } else if (state.kind === 'moving' && current) {
        const [lon, lat] = toLonLat(e);
        const next = moveShape(current, lon - state.last[0], lat - state.last[1]);
        interaction.current = { kind: 'moving', last: [lon, lat] };
        live.current.onShapeChange(next);
      } else if (state.kind === 'resizing' && current) {
        live.current.onShapeChange(resizeShape(current, toLonLat(e)));
      } else if (state.kind === 'vertex') {
        const { editingRouteId: id, editPoints } = live.current;
        if (id && editPoints) {
          live.current.onRouteEdited(id, moveVertex(editPoints, state.index, toLonLat(e)));
        }
      }
    });

    m.on('mousedown', (e: MapMouseEvent) => {
      // Primary button only. A right-click fires mousedown before contextmenu,
      // and the matching mouseup does not arrive, so grabbing a handle here
      // left it glued to the pointer — right-click a vertex to delete it and
      // it followed the cursor around the map instead.
      if (e.originalEvent.button !== 0) return;

      const { tool: activeTool, shape: current } = live.current;

      if (activeTool && !isClickTool(activeTool)) {
        interaction.current = { kind: 'drawing', start: toLonLat(e) };
        m.dragPan.disable();
        return;
      }

      const { editingRouteId: id, editPoints } = live.current;
      if (!activeTool && id && editPoints) {
        // Vertex handles are tested BEFORE the selection's, because they are
        // drawn on top and the one under the cursor is the one meant.
        const layers = ['route-vertices', 'vertex-midpoints'].filter((l) => m.getLayer(l));
        const hit = m.queryRenderedFeatures(e.point, { layers })[0];
        const index = hit?.properties?.['index'];

        if (hit && typeof index === 'number') {
          // Alt-click deletes, for anyone whose trackpad makes a right-click a
          // two-step affair. Right-click below does the same thing.
          if (hit.properties?.['role'] === 'vertex' && e.originalEvent.altKey) {
            removeVertexAt(id, editPoints, index);
            return;
          }
          if (hit.properties?.['role'] === 'midpoint') {
            // One gesture inserts the point AND places it: the new vertex takes
            // the midpoint's index, so the drag that follows is already on it.
            live.current.onRouteEdited(id, insertVertex(editPoints, index, toLonLat(e)));
          }
          interaction.current = { kind: 'vertex', index };
          m.dragPan.disable();
          return;
        }
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

      // A drag ends where the button came up, which is not always where the
      // last mousemove landed.
      if (state.kind === 'vertex') {
        const { editingRouteId: id, editPoints } = live.current;
        if (id && editPoints) {
          live.current.onRouteEdited(id, moveVertex(editPoints, state.index, toLonLat(e)));
        }
      }

      if (state.kind !== 'points') {
        interaction.current = { kind: 'idle' };
        m.dragPan.enable();
      }
    });

    /**
     * Right-click a vertex to remove it.
     *
     * The gesture every map editor uses, and the only one that does not need a
     * mode of its own: alt-click does the same for trackpads.
     */
    m.on('contextmenu', (e: MapMouseEvent) => {
      const { editingRouteId: id, editPoints } = live.current;
      if (!id || !editPoints || live.current.tool) return;
      const layers = ['route-vertices'].filter((l) => m.getLayer(l));
      const hit = m.queryRenderedFeatures(e.point, { layers })[0];
      const index = hit?.properties?.['index'];
      if (typeof index !== 'number') return;
      e.preventDefault();
      removeVertexAt(id, editPoints, index);
    });

    // Polygon and route are click-to-add rather than drag.
    m.on('click', (e: MapMouseEvent) => {
      if (!isClickTool(live.current.tool)) return;
      const state = interaction.current;
      const here = toLonLat(e);
      const existing = state.kind === 'points' ? state.points : [];

      // A double-click fires TWO clicks before dblclick, so finishing a line
      // otherwise left a duplicate vertex on the end. Dropping a click that
      // lands on the previous point costs nothing — nobody places two vertices
      // in the same spot on purpose — and it makes the point count match the
      // number of places actually clicked.
      const last = existing[existing.length - 1];
      if (last && samePlace(m, last, here)) return;

      const points = [...existing, here];
      interaction.current = { kind: 'points', points };
      setData('draft', pointsToGeoJSON(points));
    });

    m.on('dblclick', (e: MapMouseEvent) => {
      const state = interaction.current;
      const activeTool = live.current.tool;
      if (!isClickTool(activeTool) || state.kind !== 'points') return;
      e.preventDefault();

      // The double-click fires after the click that placed the last vertex, so
      // the point under the cursor is already in the list.
      const points = state.points;
      interaction.current = { kind: 'idle' };
      setData('draft', EMPTY);

      if (activeTool === 'route') {
        // Two points is a line; a route does not need to enclose anything.
        if (points.length >= 2) {
          live.current.onRouteDrawn(points);
          live.current.onToolFinished();
        }
        return;
      }

      const next = finishPolygon(points);
      if (next) {
        live.current.onShapeChange(next);
        live.current.onToolFinished();
      }
    });

    /**
     * Backspace takes back the last vertex, Escape abandons the line.
     *
     * A click tool has no other way out: with no undo, one misplaced vertex
     * means starting the whole route again.
     */
    const onKey = (event: KeyboardEvent) => {
      const state = interaction.current;
      if (!isClickTool(live.current.tool) || state.kind !== 'points') return;

      if (event.key === 'Escape') {
        interaction.current = { kind: 'idle' };
        setData('draft', EMPTY);
        live.current.onToolFinished();
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        const points = state.points.slice(0, -1);
        interaction.current = points.length > 0 ? { kind: 'points', points } : { kind: 'idle' };
        setData('draft', pointsToGeoJSON(points));
      } else if (event.key === 'Enter' && live.current.tool === 'route' && state.points.length >= 2) {
        interaction.current = { kind: 'idle' };
        setData('draft', EMPTY);
        live.current.onRouteDrawn(state.points);
        live.current.onToolFinished();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
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

  const mountedBasemap = useRef(basemapId);
  useEffect(() => {
    const m = map.current;
    const style = BASEMAPS.find((b) => b.id === basemapId);
    // Skip the first run: the map was constructed with this style already, and
    // calling setStyle straight after construction aborts the load in flight.
    if (!m || !style || mountedBasemap.current === basemapId) return;
    mountedBasemap.current = basemapId;
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
    if (!ready.current) return;
    setData('vertices', editPoints ? vertexHandles(editPoints) : EMPTY);
  }, [editPoints, setData, basemapId]);

  useEffect(() => {
    if (!ready.current) return;
    setData('features', featurePreview ?? { type: 'FeatureCollection', features: [] });
  }, [featurePreview, setData, basemapId]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.getCanvas().style.cursor = tool ? 'crosshair' : '';
  }, [tool]);

  // Presets and Fit-to-routes change the selection without touching the map, so
  // the view has to be told to go there — otherwise the shape is drawn somewhere
  // off screen and the map looks empty.
  useEffect(() => {
    const m = map.current;
    if (!m || !shape) return;
    const box = selectionBBox(shape);
    m.fitBounds([box.west, box.south, box.east, box.north], { padding: 60, duration: 800 });
    // Only when the nonce changes; shape edits from dragging must not re-frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitNonce]);

  // "My location" moves the VIEW only. The selection is a separate thing and
  // silently relocating it would be a far ruder surprise than a map pan.
  useEffect(() => {
    const m = map.current;
    if (!m || !flyTo) return;
    m.flyTo({ center: flyTo, zoom: Math.max(m.getZoom(), 11), duration: 1200 });
  }, [flyTo]);

  return <div className="mapview" ref={container} />;
}
