import os

import uvicorn


def create_app():
    from video_review_backend.api import app

    return app


if __name__ == "__main__":
    reload_enabled = os.environ.get("GYMCLIP_BACKEND_RELOAD", "0") == "1"
    uvicorn.run(
        "video_review_backend.api:app" if reload_enabled else create_app(),
        host=os.environ.get("GYMCLIP_BACKEND_HOST", "127.0.0.1"),
        port=int(os.environ.get("GYMCLIP_BACKEND_PORT", "8000")),
        reload=reload_enabled,
    )
