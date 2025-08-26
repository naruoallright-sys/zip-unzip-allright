from flask import Flask, request, jsonify
import base64
import io
import pyzipper  # AES 暗号 ZIP に対応

app = Flask(__name__)

@app.route("/unzip", methods=["POST"])
def unzip_endpoint():
    data = request.get_json()
    filedata = data.get("filedata")
    password = data.get("password")

    try:
        # base64 → バイナリ変換
        zip_bytes = base64.b64decode(filedata)
        zip_buffer = io.BytesIO(zip_bytes)
        extracted_files = []

        # AES 暗号化 ZIP の解凍
        with pyzipper.AESZipFile(zip_buffer) as zf:
            zf.pwd = password.encode("utf-8")  # パスワードをセット
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
        # パスワードエラーなど
        return jsonify({"error": f"解凍失敗: {str(e)}"}), 400
    except Exception as e:
        return jsonify({"error": f"処理失敗: {str(e)}"}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
