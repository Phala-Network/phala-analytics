import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import '@/index.css'
import {App} from '@/App'
import {ThemeProvider} from '@/components/theme-provider'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(
  <StrictMode>
    {/* The CSP blocks the <style> element used to pause transitions on change. */}
    <ThemeProvider disableTransitionOnChange={false}>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
