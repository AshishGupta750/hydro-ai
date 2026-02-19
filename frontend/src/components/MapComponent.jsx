import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, FeatureGroup, LayersControl, useMap } from 'react-leaflet';
import { EditControl } from 'react-leaflet-draw';
import { BarChart, Bar, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Search, Loader2, MousePointer2, ChevronDown, ChevronUp, Maximize2, MapPin, FileDown } from 'lucide-react';
import { OpenStreetMapProvider } from 'leaflet-geosearch';
import axios from 'axios';
import jsPDF from 'jspdf';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';

// Fix Leaflet Icons
import L from 'leaflet';
window.L = L; // Fix for Draw tools

// Use the online URL if it exists, otherwise use localhost
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// --- HELPER: CONVERT CIRCLE TO POLYGON ---
// (Required so the backend can analyze the area inside the circle)
const createCirclePolygon = (layer) => {
  const center = layer.getLatLng();
  const radius = layer.getRadius();
  const points = 64; 
  const coords = [];
  
  const distanceX = radius / (111320.0 * Math.cos(center.lat * Math.PI / 180.0));
  const distanceY = radius / 110574.0;

  for (let i = 0; i < points; i++) {
    const theta = (i / points) * (2 * Math.PI);
    const x = distanceX * Math.cos(theta);
    const y = distanceY * Math.sin(theta);
    coords.push([center.lng + x, center.lat + y]);
  }
  coords.push(coords[0]); 
  
  return { 
    type: 'Polygon', 
    coordinates: [coords] 
  };
};

// --- SUB-COMPONENT: SMART SEARCH BAR ---
const SearchField = ({ setLocationName }) => {
  const map = useMap();
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (query.length > 2) {
        const provider = new OpenStreetMapProvider();
        const results = await provider.search({ query });
        setSuggestions(results);
        setIsOpen(true);
      } else {
        setSuggestions([]);
        setIsOpen(false);
      }
    }, 300);
    return () => clearTimeout(delayDebounceFn);
  }, [query]);

  const handleSelect = (result) => {
    const { x, y, label } = result;
    map.flyTo([y, x], 13, { duration: 2 });
    setQuery(label);
    setLocationName(label);
    setIsOpen(false);
  };

  return (
    <div ref={wrapperRef} className="absolute top-4 left-1/2 transform -translate-x-1/2 z-[1000] w-96 font-sans">
      <div className="relative shadow-xl group">
        <input 
            type="text" 
            placeholder="Search location (e.g. Sukhna Lake)..." 
            className="w-full py-3 pl-10 pr-4 bg-white/95 backdrop-blur-md text-gray-800 rounded-full border border-gray-200 focus:ring-4 ring-blue-500/20 outline-none text-sm shadow-sm transition-all"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => query.length > 2 && setIsOpen(true)}
        />
        <Search className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
      </div>
      {isOpen && suggestions.length > 0 && (
        <ul className="absolute top-12 left-0 w-full bg-white/95 backdrop-blur-xl rounded-2xl shadow-xl overflow-hidden border border-gray-100 animate-in fade-in slide-in-from-top-2">
          {suggestions.slice(0, 5).map((result, idx) => (
            <li key={idx} onClick={() => handleSelect(result)} className="px-4 py-3 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-none flex items-center gap-3 transition-colors">
              <MapPin className="w-4 h-4 text-blue-500 shrink-0" />
              <span className="text-sm text-gray-700 truncate">{result.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// --- MAIN COMPONENT ---
const MapComponent = () => {
  const [dates, setDates] = useState({
    t1_start: '2023-04-01', t1_end: '2023-05-30',
    t2_start: '2023-11-01', t2_end: '2023-11-30',
  });
  
  const [geoJson, setGeoJson] = useState(null);
  const [tileUrl, setTileUrl] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [locationName, setLocationName] = useState('Custom Region of Interest'); 

  // --- UPDATED HANDLER FOR CIRCLE & POLYGON ---
  const onCreated = (e) => {
    const { layerType, layer } = e;
    
    if (layerType === 'circle') {
      // 1. Handle Circle: Convert to Polygon
      const polygon = createCirclePolygon(layer);
      setGeoJson(polygon);
    } 
    else if (layerType === 'polygon') {
      // 2. Handle Polygon
      const geo = layer.toGeoJSON();
      setGeoJson(geo.geometry);
    }
  };

  const handleAnalyze = async () => {
    if (!geoJson) {
      alert("⚠️ Draw a shape first!");
      return;
    }
    setLoading(true);
    try {
      const payload = {
        geojson: geoJson,
        date1_start: dates.t1_start, date1_end: dates.t1_end,
        date2_start: dates.t2_start, date2_end: dates.t2_end
      };
      
      const response = await axios.post(`${API_URL}/analyze`, payload);
      setTileUrl(response.data.tile_url);
      setStats(response.data.stats);

    } catch (error) {
      console.error("Full Error:", error);
      let userMessage = "Connection refused. Is the backend running?";
      let suggestion = "Check your terminal.";

      if (error.response) {
        const detail = error.response.data.detail || "";
        if (error.response.status === 404 || detail.includes("No clear images")) {
          userMessage = "☁️ Too Cloudy / No Data Found";
          suggestion = detail;
        } else if (error.response.status === 500) {
          userMessage = "Server Error";
          suggestion = "The area might be too large or the backend crashed.";
        } else {
          userMessage = `Error: ${detail}`;
        }
      }
      alert(`❌ ${userMessage}\n\n💡 ${suggestion}`);
    } finally {
      setLoading(false);
    }
  };

  const generatePDF = () => {
    if (!stats) return;
    const doc = new jsPDF();
    const today = new Date().toLocaleDateString();

    doc.setFillColor(30, 41, 59);
    doc.rect(0, 0, 210, 40, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(22);
    doc.text("Waterbody Analysis Report", 20, 20);
    doc.setFontSize(10);
    doc.text("Generated by HydroAI Mission Control", 20, 30);
    doc.text(`Date: ${today}`, 160, 30);

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(14);
    doc.text("Target Location:", 20, 60);
    doc.setFontSize(12);
    doc.text(locationName, 20, 70);

    doc.setDrawColor(200, 200, 200);
    doc.line(20, 80, 190, 80);
    
    doc.setFontSize(14);
    doc.text("Analysis Parameters", 20, 95);
    doc.setFontSize(10);
    doc.setTextColor(100, 100, 100);
    doc.text(`Baseline Period (T1): ${dates.t1_start} to ${dates.t1_end}`, 20, 105);
    doc.text(`Comparison Period (T2): ${dates.t2_start} to ${dates.t2_end}`, 20, 112);

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(14);
    doc.text("Change Detection Results", 20, 130);

    doc.setFillColor(240, 240, 240);
    doc.rect(20, 135, 170, 10, 'F');
    doc.setFontSize(10);
    doc.font = "bold";
    doc.text("Metric", 25, 141);
    doc.text("Area (sq km)", 150, 141);

    let y = 155;
    doc.setTextColor(0, 150, 0);
    doc.text("Water Gain (New Water)", 25, y);
    doc.text(`${stats.gain_sqkm.toFixed(4)} km²`, 150, y);
    doc.line(20, y+2, 190, y+2);
    
    y += 15;
    doc.setTextColor(200, 0, 0);
    doc.text("Water Loss (Dried Up)", 25, y);
    doc.text(`${stats.loss_sqkm.toFixed(4)} km²`, 150, y);
    doc.line(20, y+2, 190, y+2);

    y += 15;
    doc.setTextColor(0, 0, 150);
    doc.text("Persistent Water (Stable)", 25, y);
    doc.text(`${stats.persistent_sqkm.toFixed(4)} km²`, 150, y);
    doc.line(20, y+2, 190, y+2);

    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text("Analysis based on Sentinel-2 Satellite Imagery (10m Resolution).", 20, 280);
    doc.save("HydroAI_Analysis_Report.pdf");
  };

  const chartData = stats ? [
    { name: 'Gain', value: stats.gain_sqkm, color: '#10b981' }, 
    { name: 'Loss', value: stats.loss_sqkm, color: '#ef4444' }, 
    { name: 'Stable', value: stats.persistent_sqkm, color: '#3b82f6' }, 
  ] : [];

  return (
    <div className="relative h-screen w-full bg-slate-50 overflow-hidden font-sans">
      
      {/* --- MAP CONTAINER --- */}
      <MapContainer 
        center={[20.5937, 78.9629]} 
        zoom={5} 
        className="h-full w-full z-0" 
        zoomControl={false}
        doubleClickZoom={false} // Prevent polygon getting stuck
      >
        <SearchField setLocationName={setLocationName} />
        
        <LayersControl position="bottomright">
          
          {/* 1. STREET MAP (OSM) - DEFAULT CHECKED */}
          <LayersControl.BaseLayer checked name="Street Map (OSM)">
             <TileLayer 
               url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" 
               attribution='&copy; OSM'
             />
          </LayersControl.BaseLayer>

          {/* 2. SATELLITE */}
          <LayersControl.BaseLayer name="Satellite Imagery">
             <TileLayer 
               url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" 
               attribution='&copy; Esri'
             />
          </LayersControl.BaseLayer>

          {/* 3. DARK MODE */}
          <LayersControl.BaseLayer name="Dark Mode">
             <TileLayer 
               url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" 
               attribution='&copy; CARTO'
             />
          </LayersControl.BaseLayer>

          {/* 4. LIGHT MODE */}
          <LayersControl.BaseLayer name="Light Mode">
             <TileLayer 
               url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" 
               attribution='&copy; CARTO'
             />
          </LayersControl.BaseLayer>

          {/* Analysis Overlay */}
          {tileUrl && (
            <LayersControl.Overlay checked name="Water Analysis">
              <TileLayer url={tileUrl} opacity={0.9} />
            </LayersControl.Overlay>
          )}
        </LayersControl>

        <FeatureGroup>
          {/* --- CHANGED HERE: Rectangle FALSE, Circle TRUE, Polygon TRUE --- */}
          <EditControl 
            position="topright" 
            onCreated={onCreated} 
            draw={{ 
                rectangle: false, 
                circle: true, 
                polygon: true, 
                marker: false, 
                polyline: false, 
                circlemarker: false 
            }} 
          />
        </FeatureGroup>
      </MapContainer>

      {/* --- HUD CONTROL PANEL (LEFT) - LIGHT THEME --- */}
      <div className={`absolute top-24 left-4 z-[1000] transition-all duration-300 ${panelOpen ? 'w-80' : 'w-14'} bg-white/95 border-gray-200 text-slate-800 backdrop-blur-xl border rounded-2xl shadow-xl overflow-hidden`}>
        <div className="p-3 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center cursor-pointer" onClick={() => setPanelOpen(!panelOpen)}>
            {panelOpen && <h2 className="font-bold text-sm uppercase tracking-wider flex items-center gap-2 text-slate-700"><MousePointer2 className="w-4 h-4 text-blue-600"/> Mission Control</h2>}
            {panelOpen ? <ChevronUp className="w-4 h-4 text-gray-400"/> : <ChevronDown className="w-4 h-4 text-gray-400 mx-auto"/>}
        </div>

        {panelOpen && (
          <div className="p-5 space-y-6">
            <div className="space-y-4">
               <div className="group">
                 <label className="text-[10px] text-slate-500 uppercase font-bold mb-1 block">Baseline (T1)</label>
                 <div className="grid grid-cols-2 gap-2">
                   <input type="date" className="text-xs p-2 rounded border border-gray-300 focus:ring-2 ring-blue-500/50 outline-none w-full bg-white text-slate-700" 
                     value={dates.t1_start} onChange={e=>setDates({...dates, t1_start:e.target.value})} />
                   <input type="date" className="text-xs p-2 rounded border border-gray-300 focus:ring-2 ring-blue-500/50 outline-none w-full bg-white text-slate-700" 
                     value={dates.t1_end} onChange={e=>setDates({...dates, t1_end:e.target.value})} />
                 </div>
               </div>
               <div className="group">
                 <label className="text-[10px] text-slate-500 uppercase font-bold mb-1 block">Comparison (T2)</label>
                 <div className="grid grid-cols-2 gap-2">
                   <input type="date" className="text-xs p-2 rounded border border-gray-300 focus:ring-2 ring-blue-500/50 outline-none w-full bg-white text-slate-700" 
                     value={dates.t2_start} onChange={e=>setDates({...dates, t2_start:e.target.value})} />
                   <input type="date" className="text-xs p-2 rounded border border-gray-300 focus:ring-2 ring-blue-500/50 outline-none w-full bg-white text-slate-700" 
                     value={dates.t2_end} onChange={e=>setDates({...dates, t2_end:e.target.value})} />
                 </div>
               </div>
            </div>

            <button onClick={handleAnalyze} disabled={loading} className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold shadow-lg shadow-blue-500/20 transition-all active:scale-95 flex items-center justify-center gap-2">
              {loading ? <Loader2 className="w-4 h-4 animate-spin"/> : <Maximize2 className="w-4 h-4"/>}
              {loading ? 'Scanning...' : 'Detect Change'}
            </button>
          </div>
        )}
      </div>

      {/* --- RESULTS DOCK (Bottom) - LIGHT THEME --- */}
      {stats && (
        <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 z-[1000] w-[90%] max-w-4xl backdrop-blur-xl border rounded-2xl shadow-2xl p-6 flex flex-col md:flex-row gap-8 items-center animate-in slide-in-from-bottom-10 fade-in duration-500 bg-white/95 border-gray-200 text-slate-800">
            <div className="flex-1 grid grid-cols-3 gap-4 w-full">
                <div className="text-center p-3 rounded-xl border bg-gray-50 border-gray-200">
                    <p className="text-xs text-emerald-600 font-bold uppercase mb-1">Water Gain</p>
                    <p className="text-2xl font-bold text-slate-800">{stats.gain_sqkm.toFixed(2)}</p>
                    <p className="text-[10px] text-slate-400">sq. km</p>
                </div>
                <div className="text-center p-3 rounded-xl border bg-gray-50 border-gray-200">
                    <p className="text-xs text-rose-600 font-bold uppercase mb-1">Water Loss</p>
                    <p className="text-2xl font-bold text-slate-800">{stats.loss_sqkm.toFixed(2)}</p>
                    <p className="text-[10px] text-slate-400">sq. km</p>
                </div>
                <div className="text-center p-3 rounded-xl border bg-gray-50 border-gray-200">
                    <p className="text-xs text-blue-600 font-bold uppercase mb-1">Persistent</p>
                    <p className="text-2xl font-bold text-slate-800">{stats.persistent_sqkm.toFixed(2)}</p>
                    <p className="text-[10px] text-slate-400">sq. km</p>
                </div>
            </div>

            <div className="w-full md:w-64 h-24 relative group">
               <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <Tooltip 
                      cursor={{fill: 'transparent'}} 
                      contentStyle={{backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', color: '#1e293b'}} 
                      itemStyle={{color: '#1e293b'}}
                    />
                    <Bar dataKey="value" radius={[4, 4, 4, 4]}>
                      {chartData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
                    </Bar>
                  </BarChart>
               </ResponsiveContainer>
               
               <button 
                onClick={generatePDF}
                className="absolute -top-3 -right-3 p-2 bg-slate-800 text-white rounded-full shadow-lg hover:bg-slate-700 transition-all active:scale-95 border border-slate-700 group-hover:opacity-100 opacity-0 transition-opacity"
                title="Download Report PDF"
               >
                 <FileDown className="w-4 h-4" />
               </button>
               
               <div className="absolute -bottom-6 right-0 w-full text-center">
                  <button onClick={generatePDF} className="text-[10px] text-blue-600 hover:text-blue-500 flex items-center justify-center gap-1 w-full mt-2 font-medium">
                    <FileDown className="w-3 h-3"/> Download Report
                  </button>
               </div>
            </div>
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 bg-white/60 backdrop-blur-[2px] z-[2000] flex flex-col items-center justify-center text-slate-800">
            <Loader2 className="w-12 h-12 animate-spin text-blue-600 mb-4" />
            <h2 className="font-mono text-lg tracking-[0.2em] animate-pulse font-bold text-slate-900">PROCESSING SATELLITE DATA</h2>
        </div>
      )}

    </div>
  );
};

export default MapComponent;