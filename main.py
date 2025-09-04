from flask import Flask, request, jsonify
import base64
import io
import pyzipper  # AES 暗号 ZIP に対応
from google.oauth2 import service_account
from googleapiclient.discovery import build

app = Flask(__name__)

# Google Drive API 認証設定
# サービスアカウントキー (JSON) を Render に環境変数で埋め込む方式推奨
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
SERVICE_ACCOUNT_FILE = "service_account.json"  # Render にアップロード or 環境変数経由

credentials = service_account.Credentials.from_service_account_file(
    SERVICE_ACCOUNT_FILE, scopes=SCOPES
)
drive_service = build("drive", "v3", credentials=credentials)


@app.route("/unzip", methods=["POST"])
def unzip_endpoint():
    data = request.get_json()
    file_id = data.get("fileId")
    password = data.get("password")

    if not file_id or not password:
        return jsonify({"error": "fileId と password が必要です"}), 400

    try:
        # Google Drive から ZIP ファイルをダウンロード
        request_drive = drive_service.files().get_media(fileId=file_id)
        file_bytes = io.BytesIO()
        downloader = build("drive", "v3", credentials=credentials)._http.request
        response, content = downloader(request_drive.uri, "GET")

        if response.status != 200:
            return jsonify({"error": f"Drive ダウンロード失敗: {response.status}"}), 500

        zip_buffer = io.BytesIO(content)
        extracted_files = []

        # AES 暗号化 ZIP の解凍
        with pyzipper.AESZipFile(zip_buffer) as zf:
            zf.pwd = password.encode("utf-8")
            for info in zf.infolist():
                if not info.is_dir():
                    file_bytes = zf.read(info.filename)
                    file_b64 = base64.b64encode(file_bytes).decode("utf-8")
                    extracted_files.append({
                        "name": info.filename,
                        "data": file_b64
                    })

        return jsonify({"files": extracted_files})

    except RuntimeError as e:
        return jsonify({"error": f"解凍失敗: {str(e)}"}), 400
    except Exception as e:
        return jsonify({"error": f"処理失敗: {str(e)}"}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
