"""Isolated browser-fixture server. Never points at the user's actual library."""
from pathlib import Path
import tempfile
import uvicorn
from backend import storage
from backend.main import app


def main():
    with tempfile.TemporaryDirectory(prefix='basstrace-qa-') as directory:
        storage.DATA_ROOT = Path(directory)

        @app.get('/api/test-library')
        def test_library():
            return {'isolated': True, 'fixture': 'basstrace-library-transfer'}

        # Register ahead of the SPA's catch-all route.
        app.router.routes.insert(0, app.router.routes.pop())
        uvicorn.run(app, host='127.0.0.1', port=8003)


if __name__ == '__main__':
    main()
