#!/bin/bash

echo "🔍 测试 Ollama 本地模型连接..."
echo ""

# 测试 Ollama 服务
echo "1️⃣ 测试 Ollama 服务..."
if curl -s http://localhost:11434/api/tags > /dev/null; then
    echo "✅ Ollama 服务正常运行"
else
    echo "❌ Ollama 服务未运行"
    echo "   请运行: ollama serve"
    exit 1
fi

echo ""
echo "2️⃣ 测试模型列表..."
models=$(curl -s http://localhost:11434/api/tags | python3 -c "import sys, json; data=json.load(sys.stdin); print('\n'.join([m['name'] for m in data['models']]))")
echo "已安装的模型:"
echo "$models" | while read model; do
    echo "  - $model"
done

echo ""
echo "3️⃣ 测试模型调用 (qwen3-vl:2b)..."
echo "正在发送测试消息..."
response=$(curl -s http://localhost:11434/api/generate -d '{
    "model": "qwen3-vl:2b",
    "prompt": "你好，请简短回复",
    "stream": false
}')

if echo "$response" | python3 -c "import sys, json; data=json.load(sys.stdin); print('✅ 模型响应成功:', data.get('response', '')[:50])" 2>/dev/null; then
    echo ""
    echo "4️⃣ 测试 /api/chat 接口..."
    chat_response=$(curl -s http://localhost:11434/api/chat -d '{
        "model": "qwen3-vl:2b",
        "messages": [{"role": "user", "content": "你好"}],
        "stream": false
    }')
    
    if echo "$chat_response" | python3 -c "import sys, json; data=json.load(sys.stdin); print('✅ Chat 接口正常:', data.get('message', {}).get('content', '')[:50])" 2>/dev/null; then
        echo ""
        echo "✨ 所有测试通过！"
        echo ""
        echo "📝 如果应用仍然报错，可能的原因:"
        echo "  1. Electron 应用未重启，需要刷新页面"
        echo "  2. 模型未加载，第一次调用需要等待模型加载"
        echo "  3. 检查浏览器控制台是否有详细错误信息"
        echo ""
        echo "🔧 建议操作:"
        echo "  - 在应用中按 Cmd+R (Mac) 或 Ctrl+R (Windows/Linux) 刷新页面"
        echo "  - 打开开发者工具查看控制台日志"
        echo "  - 第一次使用某个模型时，请等待 10-30 秒让模型加载"
    else
        echo "❌ Chat 接口测试失败"
        echo "$chat_response"
    fi
else
    echo "❌ 模型调用失败"
    echo "$response"
fi

echo ""
