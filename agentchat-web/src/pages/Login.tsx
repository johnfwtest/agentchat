import { useState } from 'react'
import { Card, Form, Input, Button, message } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { useStore } from '../store'

export default function Login() {
  const login = useStore(s => s.login)
  const [loading, setLoading] = useState(false)

  const onFinish = async (vals: { username: string; password: string }) => {
    setLoading(true)
    try {
      await login(vals.username, vals.password)
      message.success('登录成功')
    } catch (e: any) {
      message.error(e.message || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center',
                  alignItems: 'center',
                  height: 'var(--app-height, 100vh)' }}>
      <Card title="AgentChat 登录" style={{ width: 360 }}>
        <Form onFinish={onFinish}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" autoFocus />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  )
}
