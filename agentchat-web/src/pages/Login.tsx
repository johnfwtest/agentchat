import { useState } from 'react'
import { Card, Form, Input, Button, Select, message } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { useStore } from '../store'
import { t, useLang, setLang, Lang } from '../i18n'

export default function Login() {
  const login = useStore(s => s.login)
  const [loading, setLoading] = useState(false)
  const lang = useLang()   // 订阅语言变化，切换即时生效

  const onFinish = async (vals: { username: string; password: string }) => {
    setLoading(true)
    try {
      await login(vals.username, vals.password)
      message.success(t('login.success'))
    } catch (e: any) {
      message.error(e.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center',
                  alignItems: 'center',
                  height: 'var(--app-height, 100vh)' }}>
      <Card title={t('login.title')} style={{ width: 360 }}>
        <Form onFinish={onFinish}>
          <Form.Item name="username" rules={[{ required: true, message: t('login.username') }]}>
            <Input prefix={<UserOutlined />} placeholder={t('login.username')} autoFocus />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: t('login.password') }]}>
            <Input.Password prefix={<LockOutlined />} placeholder={t('login.password')} />
          </Form.Item>
          <Form.Item label={t('login.lang')} style={{ marginBottom: 16 }}>
            <Select value={lang} onChange={v => setLang(v as Lang)}
                    options={[{ value: 'zh', label: '中文' },
                              { value: 'en', label: 'English' }]} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            {t('login.submit')}
          </Button>
        </Form>
      </Card>
    </div>
  )
}
