#!/usr/bin/env python3
"""One-time YouTube OAuth2 authentication.

Run this ONCE on your local machine to get a token:
    pip install google-auth-oauthlib google-api-python-client
    python tools/youtube_auth.py

Then copy the output token into .env:
    YOUTUBE_TOKEN_JSON={"token":...}

Or mount the token file via docker-compose.yml.
"""
import json
import sys
from pathlib import Path

try:
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
except ImportError:
    sys.exit("pip install google-auth-oauthlib google-api-python-client")

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]

CLIENT_SECRETS = Path(__file__).parent.parent / "youtube_client_secrets.json"
TOKEN_OUT      = Path(__file__).parent.parent / "youtube_token.json"

if not CLIENT_SECRETS.exists():
    print(f"""
Missing: {CLIENT_SECRETS}

Steps:
1. Go to console.cloud.google.com
2. Create project → Enable YouTube Data API v3
3. Credentials → OAuth 2.0 Client IDs → Desktop app
4. Download JSON → save as: {CLIENT_SECRETS}
5. Run this script again
""")
    sys.exit(1)

flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRETS), SCOPES)
creds = flow.run_local_server(port=0)

TOKEN_OUT.write_text(creds.to_json())
print(f"\n✅ Token saved to: {TOKEN_OUT}")
print("\nAdd to .env:")
print(f"YOUTUBE_TOKEN_FILE=/app/videos/youtube_token.json")
print("\nOr copy token JSON into YOUTUBE_TOKEN_JSON env var:")
print(f"YOUTUBE_TOKEN_JSON='{TOKEN_OUT.read_text()}'")
