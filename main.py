from flask import Flask, request, jsonify
import base64
import io
import zipfile

app = Flask(__name__)

@app.route("/unzip", methods=["POST"])
def unzip_endpoint():
    try:
        data = request.get_json()
        filedata_b64 = data.get("filedata")
        password = data.get("password")

        if not filedata_b64 or not password:
            return jsonify({"error": "filedata or password missing"}), 400

        # Base64 をバイトに変換
        zip_bytes = base64.b64decode(filedata_b64)
        zip_buffer = io.BytesIO(zip_bytes)

        # ZIP ファイルを開く
        with zipfile.ZipFile(zip_buffer) as zf:
            # パスワードを bytes 型に変換
            pw_bytes = password.encode("utf-8")
            files_out = []

            for info in zf.infolist():
                if info.is_dir():
                    continue
                try:
                    # パスワードで解凍
                    with zf.open(info.filename, pwd=pw_bytes) as f:
                        file_bytes = f.read()
                        files_out.append({
                            "name": info.filename,
                            "data": base64.b64encode(file_bytes).decode("utf-8")
                        })
                except RuntimeError as e:
                    return jsonify({"error": f"解凍失敗: {info.filename}, {str(e)}"}), 400

        return jsonify({"files": files_out})

    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    # Render.com などクラウド環境では port=10000 を利用
    app.run(host="0.0.0.0", port=10000)
