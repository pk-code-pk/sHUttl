"""
Print a fresh VAPID key pair in the env-var format the backend reads.

    python gen_vapid.py >> .env

Run once per deployment and paste the output into Render's environment.
Rotating the keys invalidates every stored subscription (the browser bound
them to the old public key), so keep them stable once phones are subscribed.
"""

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid, b64urlencode


def main() -> None:
    vapid = Vapid()
    vapid.generate_keys()
    # Raw base64url is what both sides want: the browser's applicationServerKey
    # is the uncompressed public point, and py_vapid.Vapid.from_string() takes
    # the 32-byte private scalar. No PEM files to mount on Render.
    private = b64urlencode(
        vapid.private_key.private_numbers().private_value.to_bytes(32, "big")
    )
    public = b64urlencode(
        vapid.public_key.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    )
    print(f"VAPID_PUBLIC_KEY={public}")
    print(f"VAPID_PRIVATE_KEY={private}")
    print("VAPID_CLAIMS_EMAIL=mailto:you@example.com")


if __name__ == "__main__":
    main()
