// Mounted by both Finance authorization views. Melody owns provider state and callbacks.
import { AppleSignIn, GoogleSignIn } from 'pages/components'
import type { GoogleSignInProps } from 'pages/components/vanilla/GoogleSignIn'
import type { InitialProps } from 'pages/hooks'
import { Policy } from 'dtos/oauth'
import { signIn } from 'pages/tools/locale'

type Props = Omit<GoogleSignInProps, 'googleClientId'> & {
  initialProps: InitialProps
  signUp?: boolean
}

const emailDivider = {
  en: 'or continue with email',
  fr: 'ou continuer par e-mail',
  zh: '或使用邮箱继续',
}

export default function FinanceMethods({ initialProps, signUp, ...auth }: Props) {
  const { googleClientId, appleClientId } = initialProps
  const showFinancePasskey = !signUp && !initialProps.allowPasskey &&
    auth.params.policy === Policy.SignInOrSignUp &&
    window.location.pathname === '/identity/v1/view/authorize'
  if (!showFinancePasskey && !googleClientId && !appleClientId) return null
  return (
    <>
      <div className='finance-methods'>
        <GoogleSignIn googleClientId={googleClientId} {...auth} />
        <AppleSignIn appleClientId={appleClientId} {...auth} />
        {showFinancePasskey && (
          <>
            <button className='finance-passkey' type='button' data-action='login'>
              <svg aria-hidden='true' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>
                <circle cx='7' cy='12' r='4' /><path d='M11 12h10m-3 0v3m-3-3v2' />
              </svg>
              {signIn.withPasskey[auth.locale]}
            </button>
            <p role='status' id='auth-status' />
          </>
        )}
      </div>
      <p className='finance-divider'>{emailDivider[auth.locale]}</p>
    </>
  )
}
