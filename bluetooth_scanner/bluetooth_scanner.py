#hcitool name実行のためにこのスクリプトをsudoで実行する必要がある．(例:sudo ./venv/bin/python test.py )

import subprocess
import time
import json
import requests
import os
import logging
from logging.handlers import RotatingFileHandler
from dotenv import load_dotenv

# ログディレクトリの作成
log_dir = "/var/log/bluetooth_attendance"
os.makedirs(log_dir, exist_ok=True)

# ログの設定
log_file = f"{log_dir}/debug.log"
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(levelname)s - %(message)s',
                    handlers=[RotatingFileHandler(log_file, maxBytes=10*1024*1024, backupCount=3)])
logger = logging.getLogger(__name__)

# .env ファイルを読み込む
load_dotenv()

# 環境変数の取得
API_BASE_URL = os.getenv("API_BASE_URL")
ROOM_ID = int(os.getenv("ROOM_ID"))

def check_bluetooth_device(mac):
    """
    hcitool name を使ってBluetoothデバイスのオンライン状態を確認する。
    デバイス名が取得できればオンライン、それ以外はオフラインとみなす。
    """
    try:
        result = subprocess.run(["hcitool", "name", mac], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if result.stdout.strip():
            logger.info(f"{mac} is online (Device found)")
            return True
        else:
            logger.info(f"{mac} is offline (No response)")
            return False
    except subprocess.TimeoutExpired:
        logger.warning(f"Timeout expired while checking {mac}")
        return False
    except Exception as e:
        logger.error(f"Error checking {mac}: {e}")
        return False

while True:
    try:
        # APIからユーザー情報を取得
        status_response = requests.get(f"{API_BASE_URL}/status", headers={"content-type": "application/json"})
        users_json = status_response.json()
        
        macaddress_list = [i["mac_address"] for i in users_json]
        logger.info(f"Checking {len(macaddress_list)} devices.")
        
        for mac in macaddress_list:
            if check_bluetooth_device(mac):
                detected_macaddress = {"mac_address": mac, "room_id": ROOM_ID}
                notify_response = requests.post(
                    f"{API_BASE_URL}/notify-detected-user",
                    data=json.dumps(detected_macaddress),
                    headers={"content-type": "application/json"}
                )
                logger.info(f"Notified API: {detected_macaddress}, Response: {notify_response.status_code} {notify_response.text}")
            else:
                logger.info(f"{mac} is offline, skipping notification.")
    
    except requests.RequestException as e:
        logger.error(f"Error making API request: {e}")
    except Exception as e:
        logger.critical(f"Unexpected error: {e}", exc_info=True)
    
    time.sleep(60)
