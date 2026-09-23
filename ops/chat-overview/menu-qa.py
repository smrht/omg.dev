import os,json,time,sys
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
out=Path(__file__).parent
options=Options();options.add_argument('-profile');options.add_argument(os.environ['CODEX_FIREFOX_PROFILE'])
driver=webdriver.Firefox(options=options)
try:
 driver.set_window_size(1440,1000);driver.get(sys.argv[1]);wait=WebDriverWait(driver,25)
 wait.until(lambda d:d.find_elements(By.CSS_SELECTOR,'button[aria-label="Pages"]') or 'Who are you?' in d.find_element(By.TAG_NAME,'body').text)
 if 'Who are you?' in driver.find_element(By.TAG_NAME,'body').text:
  choices=[b for b in driver.find_elements(By.TAG_NAME,'button') if b.text.strip().lower().startswith('sam')]
  assert len(choices)==1, 'Expected one Sam profile in the local profile picker'
  choices[0].click()
 for label,width,height in [('desktop',1440,1000),('mobile',430,932)]:
  driver.set_window_size(width,height)
  pages=wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR,'button[aria-label="Pages"]')));pages.click()
  toggle=wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR,'[aria-label="Toggle dark mode"]')))
  before=driver.execute_script('return document.documentElement.classList.contains("dark")')
  toggle.click();wait.until(lambda d:d.execute_script('return document.documentElement.classList.contains("dark")')!=before)
  menu=driver.find_element(By.CSS_SELECTOR,'[role="menu"]');menu.screenshot(str(out/f'{label}-menu.png'))
  assert driver.find_element(By.CSS_SELECTOR,'[aria-label="Toggle film mode"]').is_displayed()
  driver.refresh();wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR,'button[aria-label="Pages"]')))
  assert driver.execute_script('return document.documentElement.classList.contains("dark")')!=before
  driver.find_element(By.CSS_SELECTOR,'button[aria-label="Pages"]').click()
  wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR,'[aria-label="Toggle dark mode"]'))).click()
  wait.until(lambda d:d.execute_script('return document.documentElement.classList.contains("dark")')==before)
  film=driver.find_element(By.CSS_SELECTOR,'[aria-label="Toggle film mode"]');film_before=driver.execute_script('return document.documentElement.classList.contains("lfg-film")');film.click()
  wait.until(lambda d:d.execute_script('return document.documentElement.classList.contains("lfg-film")')!=film_before)
  film.click();wait.until(lambda d:d.execute_script('return document.documentElement.classList.contains("lfg-film")')==film_before)
  driver.find_element(By.CSS_SELECTOR,'button[aria-label="Pages"]').click()
  print(json.dumps({'viewport':label,'dark_toggle':True,'reload_persistence':True,'film_toggle':True,'original_preferences_restored':True}),flush=True)
finally:driver.quit()
