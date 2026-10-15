import logging
import os
from typing import Dict, List, Union

import markdown
import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from app.config import settings
from app.core.exceptions import GlobalExceptionHandler
from app.routes import album_routes, lyrics_routes, playlist_routes, song_routes

BASE_URL = settings.SAAVN_BASE_URL
SAAVN_URLS = [
    f"{BASE_URL}?__call=song.getDetails",
    f"{BASE_URL}?__call=content.getAlbumDetails",
    f"{BASE_URL}?__call=playlist.getDetails",
    f"{BASE_URL}?__call=lyrics.getLyrics",
    f"{BASE_URL}?__call=autocomplete.get",
]


def create_app() -> FastAPI:
    """
    Create and configure the FastAPI application.
    Returns:
        FastAPI: Configured FastAPI application instance
    """
    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    logger = logging.getLogger(__name__)
    # Initialize FastAPI app
    fastapi_app = FastAPI(
        title="Saavn API",
        description="Unofficial API for retrieving music information from Saavn",
        version="1.0.0",
        docs_url="/docs",
        redoc_url="/redoc",
    )
    # Add CORS middleware
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # Include global exception handler
    GlobalExceptionHandler(fastapi_app)
    # Include routers
    
    @fastapi_app.get("/", response_class=HTMLResponse, tags=["Root"])
    async def read_root():
        # Path to the README file
        readme_path = os.path.join(os.path.dirname(__file__), "README.md")
        # Read and convert the README.md file to HTML
        with open(readme_path, "r", encoding="utf-8") as file:
            readme_content = file.read()
            html_content = markdown.markdown(
                readme_content, extensions=["fenced_code", "tables"]
            )
        # Add custom links for API documentation
        html_page = f"""
        <html>
            <head>
                <title>JioSaavn API</title>
            </head>
            <body>
                <nav>
                    <ul>
                        <li><a href="/docs">Swagger Docs</a></li>
                        <li><a href="/redoc">ReDoc</a></li>
                    </ul>
                </nav>
                <hr>
                {html_content}
            </body>
        </html>
        """
        return HTMLResponse(content=html_page)

    # Health check
    @fastapi_app.get("/ping", tags=["Health Check"])
    async def health_check() -> (
        Dict[str, Union[str, List[Dict[str, Union[str, bool]]]]]
    ):
        """Health check endpoint to see if you can connect to JioSaavn."""
        health_status = []

        for url in SAAVN_URLS:
            try:
                response = requests.get(url, timeout=settings.REQUEST_TIMEOUT)
                if response.status_code == 200:
                    health_status.append({"url": url, "status": "ok"})
                else:
                    health_status.append(
                        {
                            "url": url,
                            "status": f"failed with code {response.status_code}",
                        }
                    )
            except requests.exceptions.RequestException as e:
                health_status.append(
                    {"url": url, "status": f"failed with error: {str(e)}"}
                )

        overall_status = (
            "healthy"
            if all(item["status"] == "ok" for item in health_status)
            else "unhealthy"
        )

        return {"msg": "Pong!", "status": overall_status, "details": health_status}

    fastapi_app.include_router(
        song_routes.router, prefix="/song", tags=["Songs"])
    fastapi_app.include_router(
        album_routes.router, prefix="/album", tags=["Albums"])
    fastapi_app.include_router(
        playlist_routes.router, prefix="/playlist", tags=["Playlists"]
    )
    fastapi_app.include_router(
        lyrics_routes.router, prefix="/lyrics", tags=["Lyrics"])

    logger.info("Application initialized successfully")
    return fastapi_app


app = create_app()
