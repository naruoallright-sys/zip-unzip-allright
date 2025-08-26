from flask import Flask, request, jsonify
import base64

app = Flask(__name__)

@app.route("/unzip", methods=["POST"])
def unzip_endpoint():
    data = request.get_json()
    filedata = data.get("filedata")
    password = data.get("password")
    
    # ここに ZIP 解凍処理を追加可能
    # 今回はダミーで送信されたファイル名だけ返す
    return jsonify({"files":[{"name":"example.txt","data":filedata}]})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
