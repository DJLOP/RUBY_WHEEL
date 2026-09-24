import { useState, useCallback, useRef } from 'react';
import type { Location, District, Road, WaterBody } from '../types';
import type { SignData } from '../modules/signs';
import type { ReferenceLayer } from '../modules/referenceLayers';
import {
  fetchCanonicalGeography as fetchCanonicalGeographyData,
  EMPTY_CANONICAL_GEOGRAPHY,
  type CanonicalGeographyData,
} from '../modules/canonicalGeography/api';

export function useMapData() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [roads, setRoads] = useState<Road[]>([]);
  const [waterBodies, setWaterBodies] = useState<WaterBody[]>([]);
  const [overpasses, setOverpasses] = useState<any[]>([]);
  const [signs, setSigns] = useState<SignData[]>([]);
  const [referenceLayers, setReferenceLayers] = useState<ReferenceLayer[]>([]);

  const fetchLocations = useCallback(() => {
    fetch(`/api/locations?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setLocations(data))
      .catch(err => console.error('Error fetching locations:', err));
  }, []);

  const fetchDistricts = useCallback(() => {
    fetch(`/api/districts?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setDistricts(data))
      .catch(err => console.error('Error fetching districts:', err));
  }, []);

  const fetchRoads = useCallback(() => {
    fetch(`/api/roads?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setRoads(data))
      .catch(err => console.error('Error fetching roads:', err));
  }, []);

  const fetchWaterBodies = useCallback(() => {
    fetch(`/api/water?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setWaterBodies(data))
      .catch(err => console.error('Error fetching water:', err));
  }, []);

  const fetchOverpasses = useCallback(() => {
    fetch(`/api/overpasses?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setOverpasses(data))
      .catch(err => console.error('Error fetching overpasses:', err));
  }, []);

  const fetchSigns = useCallback(() => {
    fetch(`/api/signs?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setSigns(data))
      .catch(err => console.error('Error fetching signs:', err));
  }, []);

  const fetchReferenceLayers = useCallback(() => {
    fetch(`/api/reference-layers?_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => setReferenceLayers(data))
      .catch(err => console.error('Error fetching reference layers:', err));
  }, []);

  // Canonical geography: accepted canon for everyone, plus drafts and proposals when a
  // world-editor token has been set. The token lives in a ref so this callback stays
  // stable for the socket listener, which captures it once. A sequence number drops a
  // response that arrives after a newer request's, so rapid refreshes cannot regress.
  const [canonicalGeography, setCanonicalGeography] = useState<CanonicalGeographyData>(EMPTY_CANONICAL_GEOGRAPHY);
  const canonicalTokenRef = useRef<string | null>(null);
  const canonicalSeqRef = useRef(0);

  const fetchCanonicalGeography = useCallback(() => {
    const seq = ++canonicalSeqRef.current;
    fetchCanonicalGeographyData(canonicalTokenRef.current)
      .then(data => { if (seq === canonicalSeqRef.current) setCanonicalGeography(data); })
      .catch(err => console.error('Error fetching canonical geography:', err));
  }, []);

  /** The world editor's token (primary admin only), or null for accepted canon alone. */
  const setCanonicalWorldEditorToken = useCallback((token: string | null) => {
    canonicalTokenRef.current = token || null;
  }, []);

  const fetchAll = useCallback(() => {
    fetchLocations();
    fetchDistricts();
    fetchRoads();
    fetchWaterBodies();
    fetchOverpasses();
    fetchSigns();
    fetchReferenceLayers();
    fetchCanonicalGeography();
  }, [fetchLocations, fetchDistricts, fetchRoads, fetchWaterBodies, fetchOverpasses, fetchSigns, fetchReferenceLayers, fetchCanonicalGeography]);

  return {
    locations, setLocations,
    districts, setDistricts,
    roads, setRoads,
    waterBodies, setWaterBodies,
    overpasses, setOverpasses,
    signs, setSigns,
    referenceLayers, setReferenceLayers,
    canonicalGeography,
    fetchLocations, fetchDistricts, fetchRoads, fetchWaterBodies, fetchOverpasses, fetchSigns,
    fetchReferenceLayers, fetchCanonicalGeography, setCanonicalWorldEditorToken, fetchAll,
  };
}
