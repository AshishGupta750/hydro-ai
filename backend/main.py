import os
import ee
import uvicorn
import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 1. Initialization & Auth
load_dotenv()
try:
    service_account = os.getenv("GEE_SERVICE_ACCOUNT")
    key_file = os.getenv("GEE_KEY_FILE")
    
    if service_account and key_file and os.path.exists(key_file):
        credentials = ee.ServiceAccountCredentials(service_account, key_file)
        ee.Initialize(credentials)
        logger.info("Authentication: Service Account Initialized")
    else:
        ee.Initialize()
        logger.info("Authentication: Default Google Cloud Auth Initialized")
except Exception as e:
    logger.error(f"Authentication Failed: {e}")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- GEE Helper Functions ---

def get_sentinel_mosaic(roi, start_date, end_date):
    """Fetches Sentinel-2 data. Returns None if no clear images found."""
    try:
        # Step 1: Filter by Location and Date
        s2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED") \
            .filterBounds(roi) \
            .filterDate(start_date, end_date) \
            .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30)) # Increased tolerance to 30%
        
        # Step 2: Check if any images exist
        count = s2.size().getInfo()
        if count == 0:
            return None

        # Step 3: Mask Clouds
        def mask_clouds(image):
            qa = image.select('QA60')
            cloud_bit_mask = 1 << 10
            cirrus_bit_mask = 1 << 11
            mask = qa.bitwiseAnd(cloud_bit_mask).eq(0) \
                .And(qa.bitwiseAnd(cirrus_bit_mask).eq(0))
            return image.updateMask(mask).divide(10000)

        return s2.map(mask_clouds).median().clip(roi)
    except Exception as e:
        logger.error(f"Error fetching Sentinel data: {e}")
        raise e

def calculate_ndwi(image):
    return image.normalizedDifference(['B3', 'B8']).rename('NDWI')

def classify_water(image, threshold=0.0):
    ndwi = calculate_ndwi(image)
    return ndwi.gt(threshold).rename('water')

# --- Request Models ---

class AnalysisRequest(BaseModel):
    geojson: dict
    date1_start: str
    date1_end: str
    date2_start: str
    date2_end: str

# --- Endpoints ---

@app.post("/analyze")
async def analyze_change(request: AnalysisRequest):
    try:
        logger.info(f"Request: T1({request.date1_start}) vs T2({request.date2_start})")
        
        roi = ee.Geometry(request.geojson)

        # 1. Fetch Images
        img_t1 = get_sentinel_mosaic(roi, request.date1_start, request.date1_end)
        img_t2 = get_sentinel_mosaic(roi, request.date2_start, request.date2_end)

        # 2. Smart Error Handling
        if img_t1 is None:
            raise HTTPException(status_code=404, detail=f"No clear images found for Period 1 ({request.date1_start} to {request.date1_end}). \nSuggestion: Try a different month or expand the date range.")
        
        if img_t2 is None:
            raise HTTPException(status_code=404, detail=f"No clear images found for Period 2 ({request.date2_start} to {request.date2_end}). \nSuggestion: Monsoon clouds might be blocking the view. Try 'November' or 'April'.")

        # 3. Process Water
        water_t1 = classify_water(img_t1, 0.0)
        water_t2 = classify_water(img_t2, 0.0)

        # 4. Detect Change
        # 1=Gain(Green), 2=Loss(Red), 3=Persistent(Blue)
        change = ee.Image(0) \
            .where(water_t1.eq(0).And(water_t2.eq(1)), 1) \
            .where(water_t1.eq(1).And(water_t2.eq(0)), 2) \
            .where(water_t1.eq(1).And(water_t2.eq(1)), 3) \
            .selfMask()

        # 5. Visualization
        vis_params = {'min': 1, 'max': 3, 'palette': ['00FF00', 'FF0000', '0000FF']}
        map_id = change.getMapId(vis_params)

        # 6. Statistics (Area Calculation)
        stats = change.reduceRegion(
            reducer=ee.Reducer.frequencyHistogram(),
            geometry=roi,
            scale=10, 
            maxPixels=1e9,
            bestEffort=True
        ).getInfo()

        histogram = stats.get('constant', {})
        pixel_area_sqkm = (10 * 10) / 1e6 

        return {
            "tile_url": map_id['tile_fetcher'].url_format,
            "stats": {
                "gain_sqkm": histogram.get('1', 0) * pixel_area_sqkm,
                "loss_sqkm": histogram.get('2', 0) * pixel_area_sqkm,
                "persistent_sqkm": histogram.get('3', 0) * pixel_area_sqkm,
            }
        }

    except HTTPException as http_e:
        raise http_e
    except Exception as e:
        logger.error(f"Server Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
    
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)