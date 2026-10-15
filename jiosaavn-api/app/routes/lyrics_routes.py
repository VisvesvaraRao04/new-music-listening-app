from typing import Dict, Union

from fastapi import APIRouter, HTTPException, Query

from app.services.saavn_service import SaavnService

router = APIRouter()


@router.get("/", response_model=Dict[str, Union[bool, str]])
async def get_lyrics(
    query: str = Query(..., description="Song URL, link, or direct lyrics ID")
):
    """
    Retrieve song lyrics from Saavn.
    - **query**: Song URL, link, or direct lyrics ID
    """
    if not query:
        raise HTTPException(
            status_code=400,
            detail="Query containing song link or id is required to fetch lyrics!",
        )
    try:
        # Determine if it's a URL or direct ID
        if "http" in query and "saavn" in query:
            song_id = SaavnService.get_song_id(query)
            lyrics = SaavnService.get_lyrics(song_id)
        else:
            lyrics = SaavnService.get_lyrics(query)
        return {"status": True, "lyrics": lyrics}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error fetching lyrics: {str(e)}"
        ) from e
