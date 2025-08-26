from flask import Flask, request, jsonify
import base64
import zipfile
import io

app = Flask(__name__)

@app.route("/unzip", methods=["POST"])
def unzip_file():
    try:
        data = request.json
        filedata = base64.b64decode(data["filedata"])
        password = data.get("password")

        in_memory_zip = io.BytesIO(filedata)
        zf = zipfile.ZipFile(in_memory_zip)

        files = []
        for info in zf.infolist():
            with zf.open(info.filename, pwd=password.encode() if password else None) as f:
                content = f.read()
                files.append({
                    "name": info.filename,
                    "data": base64.b64encode(content).decode()
                })

        return jsonify({"files": files})
    except Exception as e:
        return jsonify({"error": str(e)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
